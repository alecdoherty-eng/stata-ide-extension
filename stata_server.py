import sys
import json
import time
import os
import io
import tempfile
import argparse
import threading
import queue

# Force unbuffered line output for instant IPC delivery
sys.stdout.reconfigure(line_buffering=True)

task_queue = queue.Queue()

def send_msg(msg_dict):
    print(json.dumps(msg_dict), flush=True)

def fetch_global_state(req_id=None):
    try:
        from sfi import Data, ValueLabel
        var_count = Data.getVarCount()
        vars_data = []
        safe_count = min(var_count, 4000)
        vl_cache = {}
        
        for i in range(safe_count):
            name = Data.getVarName(i)
            lbl = Data.getVarLabel(i) or ""
            fmt = Data.getVarFormat(i) or ""
            
            try:
                vtype = str(Data.getVarType(i))
            except AttributeError:
                vtype = "str" if Data.isVarString(i) else "num"
                
            val_map = {}
            try:
                vl_name = ValueLabel.getVarValueLabel(i)
                if vl_name and vl_name not in vl_cache:
                    full_map = ValueLabel.getValueLabels(vl_name)
                    keys = list(full_map.keys())
                    cached_map = {k: full_map[k] for k in keys[:10]}
                    if len(keys) > 10:
                        cached_map["..."] = f"[{len(keys)} total labels]"
                    vl_cache[vl_name] = cached_map
                val_map = vl_cache.get(vl_name, {})
            except:
                pass
                
            vars_data.append({"name": name, "label": lbl, "format": fmt, "type": vtype, "valueMap": val_map})
            
        send_msg({"type": "variables", "data": vars_data, "req_id": req_id})
    except Exception as e:
        send_msg({"type": "error", "data": f"Variables Sidebar Error: {str(e)}", "failing_command": "global_state", "req_id": req_id})

    try:
        from pystata import stata
        stored = {"r": {}, "e": {}, "s": {}, "g": {}}
        
        def extract_safe(result_dict):
            if not isinstance(result_dict, dict): return {}
            return {k: v for k, v in result_dict.items() if isinstance(v, (int, float, str, bool))}

        try: stored["r"] = extract_safe(stata.get_return())
        except: pass
        try: stored["e"] = extract_safe(stata.get_ereturn())
        except: pass
        try: stored["s"] = extract_safe(stata.get_sreturn())
        except: pass
        
        try:
            old_stdout = sys.stdout
            cap = io.StringIO()
            try:
                sys.stdout = cap
                stata.run("macro dir")
            finally:
                sys.stdout = old_stdout
                
            for line in cap.getvalue().splitlines():
                if ":" in line:
                    parts = line.split(":", 1)
                    k = parts[0].strip()
                    if not k.startswith("_") and not k.startswith("S_") and not (len(k) == 2 and k.startswith("F") and k[1].isdigit()):
                        v = parts[1].strip()
                        if v.startswith('"') and v.endswith('"'): v = v[1:-1]
                        if v.startswith('`"') and v.endswith('"\''): v = v[2:-2]
                        stored["g"][k] = v
        except:
            pass
        
        send_msg({"type": "stored_results", "data": stored, "req_id": req_id})
    except Exception:
        pass

def worker_thread():
    while True:
        req = task_queue.get()
        if req is None:
            break
            
        cmd = req.get("cmd")
        req_id = req.get("req_id")

        if cmd == "execute":
            code = req.get("code", "").strip()
            if not code:
                task_queue.task_done()
                continue
                
            start_time = time.time()
            old_stdout = sys.stdout 
            
            try:
                from pystata import stata
                captured_output = io.StringIO()
                sys.stdout = captured_output
                graph_found = None
                
                try:
                    clean_code = code.replace('\r\n', '\n')
                    stata.run(clean_code, inline=True)
                    
                    graph_path = os.path.join(tempfile.gettempdir(), 'stata_ide_graph.png').replace("\\", "/")
                    if os.path.exists(graph_path): 
                        try: os.remove(graph_path)
                        except: pass
                        
                    stata.run(f'quietly capture graph export "{graph_path}", as(png) replace')
                    
                    if os.path.exists(graph_path):
                        graph_found = graph_path
                        stata.run('quietly capture graph drop _all')
                        
                finally:
                    sys.stdout = old_stdout

                stata_log = captured_output.getvalue()
                if stata_log:
                    send_msg({"type": "output", "data": stata_log, "req_id": req_id})
                if graph_found:
                    send_msg({"type": "graph", "data": graph_found, "req_id": req_id})
                send_msg({"type": "output", "data": "\n--- Executed successfully ---\n", "req_id": req_id})
                
            except Exception as e:
                sys.stdout = old_stdout
                send_msg({"type": "error", "data": f"Stata Execution Error: {str(e)}", "req_id": req_id})
                send_msg({"type": "output", "data": f"\n[Stata Error]: {str(e)}\n", "req_id": req_id})

            send_msg({"type": "execution_finished", "duration": time.time() - start_time, "req_id": req_id})
            fetch_global_state(req_id)
            send_msg({"type": "status", "data": "idle", "req_id": req_id})

        elif cmd == "fetch_active":
            try:
                from sfi import Data
                start = req.get("start", 0)
                end = req.get("end", 100)
                target_vars = req.get("variables", [])
                
                total = Data.getObsTotal()
                var_count = Data.getVarCount()
                
                if total == 0 or var_count == 0 or start >= total:
                    send_msg({"type": "dataChunk", "data": [], "total": total, "columns": [], "req_id": req_id})
                    task_queue.task_done()
                    continue
                
                end = min(end, total)

                columns = []
                col_indices = []
                for i in range(var_count):
                    vname = Data.getVarName(i)
                    if not target_vars or vname in target_vars:
                        columns.append({"name": vname, "format": Data.getVarFormat(i)})
                        col_indices.append(i)
                
                if not columns:
                    send_msg({"type": "dataChunk", "data": [], "total": total, "columns": [], "req_id": req_id})
                    task_queue.task_done()
                    continue
                
                chunk_data = []
                for obs in range(start + 1, end + 1):
                    if obs > total:
                        break
                    row_data = {}
                    for col_idx, col_info in zip(col_indices, columns):
                        try:
                            val = Data.get(col_idx, obs)
                            if isinstance(val, (list, tuple)):
                                row_data[col_info["name"]] = val[0] if val else ""
                            else:
                                row_data[col_info["name"]] = val if val is not None else ""
                        except Exception:
                            row_data[col_info["name"]] = ""
                    chunk_data.append(row_data)
                    
                send_msg({"type": "dataChunk", "data": chunk_data, "total": total, "columns": columns, "req_id": req_id})
            except Exception as e:
                send_msg({"type": "error", "data": f"Dataset Viewer Error: {str(e)}", "req_id": req_id})
                
        task_queue.task_done()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--stata-path', type=str, default="")
    args, _ = parser.parse_known_args()

    stata_path = args.stata_path.strip().strip('"').strip("'")
    
    if stata_path:
        try:
            import stata_setup
            try:
                stata_setup.config(stata_path, 'mp')
            except Exception:
                try:
                    stata_setup.config(stata_path, 'se')
                except Exception:
                    stata_setup.config(stata_path, 'ic')
            send_msg({"type": "output", "data": "--- Stata initialized successfully ---\n"})
        except Exception as e:
            send_msg({"type": "error", "data": f"Stata Init Error: {str(e)}"})

    # Start the execution worker thread
    threading.Thread(target=worker_thread, daemon=True).start()

    fetch_global_state()
    send_msg({"type": "status", "data": "idle"})
    
    while True:
        line = sys.stdin.readline()
        if not line: break
        
        try:
            req = json.loads(line)
        except:
            continue
            
        cmd = req.get("cmd")
        req_id = req.get("req_id")

        if cmd == "ping":
            send_msg({"type": "pong", "req_id": req_id})
        elif cmd == "interrupt":
            # Clear pending queue. (Note: A blocking PyStata call in the worker thread will still finish)
            while not task_queue.empty():
                try:
                    task_queue.get_nowait()
                    task_queue.task_done()
                except queue.Empty:
                    break
            send_msg({"type": "output", "data": "\n[Stata Error]: Execution queue cleared by user.\n", "req_id": req_id})
        elif cmd in ["execute", "fetch_active"]:
            task_queue.put(req)

if __name__ == "__main__":
    main()