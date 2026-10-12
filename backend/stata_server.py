import sys
import json
import time
import os
import io
import tempfile
import argparse
import threading
import queue
import ctypes

real_stdout = sys.stdout
real_stdout.reconfigure(line_buffering=True)

stata_lock = threading.Lock()
global_state = {"latest_scroll_token": 0}

task_queue = queue.Queue()

def send_msg(msg_dict):
    print(json.dumps(msg_dict), file=real_stdout, flush=True)

class RealTimeStream:
    def __init__(self, req_id):
        self.req_id = req_id
        self.buffer = []
    
    def write(self, text):
        if not text: return
        self.buffer.append(text)
        if '\n' in text:
            send_msg({"type": "output", "data": "".join(self.buffer), "req_id": self.req_id})
            self.buffer.clear()
            
    def flush(self):
        if self.buffer:
            send_msg({"type": "output", "data": "".join(self.buffer), "req_id": self.req_id})
            self.buffer.clear()

def fetch_global_state(req_id=None):
    try:
        from sfi import Data, ValueLabel
        var_count = Data.getVarCount()
        vars_data = []
        
        for i in range(var_count):
            name = Data.getVarName(i)
            lbl = Data.getVarLabel(i) or ""
            fmt = Data.getVarFormat(i) or ""
            
            # Extract the exact Stata storage type natively
            try:
                vtype = str(Data.getVarType(i))
            except Exception:
                vtype = "str" if fmt.endswith('s') else "num"
                
            try: vlbl = ValueLabel.getVarValueLabel(name) or ""
            except: vlbl = ""
                
            vars_data.append({"index": i, "name": name, "label": lbl, "format": fmt, "type": vtype, "val_label": vlbl})
            
        send_msg({"type": "variables", "data": vars_data, "req_id": req_id})
    except Exception as e:
        send_msg({"type": "error", "data": f"Variables Sidebar Error: {str(e)}", "req_id": req_id})

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
            cap = io.StringIO()
            try:
                sys.stdout = cap
                stata.run("macro dir")
            finally:
                sys.stdout = real_stdout
                
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
            task_queue.task_done()
            break
            
        cmd = req.get("cmd")
        req_id = req.get("req_id")

        try:
            if cmd == "execute":
                code = req.get("code", "").strip()
                if not code:
                    continue
                
                send_msg({"type": "status", "data": "busy", "req_id": req_id})
                start_time = time.time()
                
                try:
                    from pystata import stata
                    ipc_stream = RealTimeStream(req_id)
                    sys.stdout = ipc_stream
                    graph_found = None
                    
                    try:
                        clean_code = code.replace('\r\n', '\n')
                        graph_keywords = ["graph", "twoway", "scatter", "histogram", "kdensity", "marginsplot", "line", "vioplot", "cumul", "coefplot", "rvfplot"]
                        has_graph = any(kw in clean_code.lower() for kw in graph_keywords)

                        is_browse = clean_code.strip().lower() == 'browse' or clean_code.strip().lower().startswith('browse ') or clean_code.strip().lower() == 'br' or clean_code.strip().lower().startswith('br ')

                        if is_browse:
                            browse_vars = []
                            parts = clean_code.strip().split()
                            for p in parts[1:]:
                                if p.lower() in ['if', 'in', ',']:
                                    break
                                browse_vars.append(p)

                            if browse_vars:
                                from sfi import Macro
                                with stata_lock:
                                    stata.run(f"capture unab _ide_browse_vars : {' '.join(browse_vars)}", inline=True)
                                    expanded = Macro.getLocal("_ide_browse_vars")
                                if not expanded:
                                    raise Exception(f"variable {' '.join(browse_vars)} not found")
                                browse_vars = expanded.split()
                                
                            send_msg({"type": "open_viewer", "req_id": req_id, "variables": browse_vars})
                        else:
                            with stata_lock:
                                stata.run(clean_code, inline=True)
                        
                        ipc_stream.flush()
                        
                        if has_graph and not is_browse:
                            import tempfile
                            with stata_lock:
                                stata.run('quietly capture graph dir', inline=True)
                                stata.run('local current_graphs `r(list)\'', inline=True)
                                from sfi import Macro
                                graph_list_str = Macro.getGlobal("current_graphs")
                            
                            if graph_list_str:
                                graphs = graph_list_str.strip().split()
                                for g in graphs:
                                    # Clean up the graph name in case of quotes
                                    g_clean = g.strip('"\'')
                                    g_path = os.path.join(tempfile.gettempdir(), f'stata_ide_graph_{g_clean}.svg').replace("\\", "/")
                                    if os.path.exists(g_path):
                                        try: os.remove(g_path)
                                        except: pass
                                    
                                    with stata_lock:
                                        stata.run(f'quietly capture graph export "{g_path}", name({g_clean}) replace', inline=True)
                                    
                                    if os.path.exists(g_path):
                                        send_msg({"type": "graph", "data": g_path, "req_id": req_id})
                            
                    finally:
                        sys.stdout = real_stdout


                    send_msg({"type": "output", "data": "\n--- Executed successfully ---\n", "req_id": req_id})
                    
                except Exception as e:
                    sys.stdout = real_stdout
                    send_msg({"type": "error", "data": str(e).strip(), "req_id": req_id})

                temp_file = req.get("temp_file")
                if temp_file and os.path.exists(temp_file):
                    try: os.remove(temp_file)
                    except: pass

                send_msg({"type": "execution_finished", "duration": time.time() - start_time, "req_id": req_id})
                fetch_global_state(req_id)
                send_msg({"type": "status", "data": "idle", "req_id": req_id})

            elif cmd == "fetch_variables":
                fetch_global_state(req_id)
                
            elif cmd == "validate_filter":
                query = req.get("query", "").strip()
                if not query:
                    send_msg({"type": "filter_validation", "valid": True, "req_id": req_id})
                    continue
                    
                try:
                    from pystata import stata
                    with stata_lock:
                        stata.run(f"quietly count if {query}", inline=True)
                    send_msg({"type": "filter_validation", "valid": True, "req_id": req_id})
                except Exception:
                    send_msg({"type": "filter_validation", "valid": False, "req_id": req_id})
                    
            elif cmd == "fetch_active":
                token = req.get("scrollToken")
                if token and token < global_state["latest_scroll_token"]:
                    continue
                    
                if not stata_lock.acquire(blocking=False):
                    send_msg({"type": "dataChunk", "data": [], "total": 0, "columns": [], "req_id": req_id})
                    continue

                try:
                    from sfi import Data, ValueLabel, Macro
                    from pystata import stata
                    
                    start = req.get("start", 0)
                    end = req.get("end", 100)
                    target_vars = req.get("variables", [])
                    row_filter = req.get("rowFilter", "").strip()
                    
                    current_frame = "default"
                    
                    if row_filter:
                        try:
                            stata.run("local _ide_cur = c(frame)", inline=True)
                            current_frame = Macro.getLocal("_ide_cur")
                        except:
                            current_frame = "default"
                            
                        stata.run("capture frame drop __ide_tmp", inline=True)
                        try:
                            stata.run(f"frame put * if {row_filter}, into(__ide_tmp)", inline=True)
                            stata.run("frame change __ide_tmp", inline=True)
                        except Exception as e:
                            stata.run(f"capture frame change {current_frame}", inline=True)
                            send_msg({"type": "error", "data": f"Filter Error: {str(e)}", "req_id": req_id})
                            continue
                    
                    try:
                        total = Data.getObsTotal()
                        var_count = Data.getVarCount()
                        
                        if total == 0 or var_count == 0 or start >= total:
                            send_msg({"type": "dataChunk", "data": [], "total": total, "columns": [], "req_id": req_id})
                            continue
                        
                        end = min(end, total)

                        if target_vars:
                            actual_vars = {Data.getVarName(i) for i in range(var_count)}
                            valid_targets = [v for v in target_vars if v in actual_vars]
                            target_vars = valid_targets if valid_targets else []

                        columns = []
                        val_labels = {}
                        
                        for i in range(var_count):
                            vname = Data.getVarName(i)
                            if not target_vars or vname in target_vars:
                                vfmt = Data.getVarFormat(i) or ""
                                is_num = not vfmt.endswith('s')
                                columns.append({"name": vname, "format": vfmt, "isNumeric": is_num})
                                
                                try:
                                    if is_num:
                                        vl_name = ValueLabel.getVarValueLabel(vname)
                                        if vl_name:
                                            val_labels[vname] = ValueLabel.getValueLabels(vl_name)
                                except Exception:
                                    pass
                        
                        if not columns:
                            send_msg({"type": "dataChunk", "data": [], "total": total, "columns": [], "req_id": req_id})
                            continue
                        
                        chunk_data = []
                        obs_range = list(range(start, end)) 
                        
                        if obs_range:
                            col_data_map = {}
                            for col_info in columns:
                                vname = col_info["name"]
                                try:
                                    vals = Data.get(vname, obs_range)
                                    if not isinstance(vals, list):
                                        vals = [Data.get(vname, o) for o in obs_range]
                                except:
                                    vals = [Data.get(vname, o) for o in obs_range]
                                col_data_map[vname] = vals

                            for i in range(len(obs_range)):
                                row_data = {}
                                for col_info in columns:
                                    vname = col_info["name"]
                                    val = col_data_map[vname][i]
                                    if isinstance(val, (list, tuple)): val = val[0] if val else ""
                                    if val is not None and vname in val_labels:
                                        try:
                                            val_int = int(val)
                                            if val_int == val and val_int in val_labels[vname]:
                                                row_data[vname] = str(val_labels[vname][val_int])
                                                continue
                                        except: pass
                                        if val in val_labels[vname]:
                                            row_data[vname] = str(val_labels[vname][val])
                                            continue
                                    if isinstance(val, float) and val > 8.9e307:
                                        val = ""
                                    row_data[vname] = val if val is not None else ""
                                chunk_data.append(row_data)
                            
                        send_msg({"type": "dataChunk", "data": chunk_data, "total": total, "columns": columns, "req_start": start, "req_id": req_id})
                    finally:
                        if row_filter:
                            stata.run(f"quietly capture frame change {current_frame}", inline=True)
                            stata.run("quietly capture frame drop __ide_tmp", inline=True)
                except Exception as e:
                    send_msg({"type": "error", "data": f"Dataset Viewer Error: {str(e)}", "req_id": req_id})
                finally:
                    if stata_lock.locked():
                        stata_lock.release()

            elif cmd == "hover_summary":
                var_name = req.get("var_name", "")
                if var_name:
                    try:
                        from pystata import stata
                        from sfi import Scalar, Data, Macro
                        import collections
                        import base64
                        
                        tot_obs = Data.getObsTotal()
                        with stata_lock:
                            idx = Data.getVarIndex(var_name)
                            fmt = Data.getVarFormat(idx)
                            is_str = fmt.startswith('%') and ('s' in fmt or 'S' in fmt)
                            is_date = fmt.startswith('%t') or fmt.startswith('%-t') or fmt.startswith('%d')
                            
                            stata.run(f"quietly capture count if !missing({var_name})", inline=True)
                            n_val = Scalar.getValue("r(N)")
                            if n_val is None or (isinstance(n_val, float) and n_val > 8.9e307): 
                                n_val = 0
                                
                            miss_pct = ((tot_obs - n_val) / tot_obs * 100) if tot_obs > 0 else 0
                            missing_str = f"{round(miss_pct, 1)}%"
                            
                            obs_range = [int(i * (tot_obs - 1) / 49999) for i in range(50000)] if tot_obs > 500000 else list(range(tot_obs))
                            
                            res = { "type": "string" if is_str else ("date" if is_date else "numeric"), "N": n_val, "missing": missing_str }
                            
                            if is_str:
                                raw_vals = Data.get(var_name, obs_range)
                                clean_vals = [val[0] if isinstance(val, (list, tuple)) else val for val in raw_vals]
                                clean_vals = [x for x in clean_vals if x and str(x).strip()]
                                
                                top_cats, unique_count, other_pct = [], 0, 0
                                total_clean = len(clean_vals)
                                
                                if total_clean > 0:
                                    counter = collections.Counter(clean_vals)
                                    unique_count = len(counter)
                                    top_3 = counter.most_common(3)
                                    top_cats = [{"val": str(k), "count": c, "pct": (c/total_clean)*100} for k, c in top_3]
                                    other_pct = ((total_clean - sum(c for k, c in top_3)) / total_clean) * 100
                                    
                                res["unique"] = unique_count
                                res["top"] = top_cats
                                res["other_pct"] = other_pct
                                
                                # Generate Stacked Bar SVG for Strings
                                w, h = 300, 16
                                svg = f'<svg width="{w}" height="{h}" xmlns="http://www.w3.org/2000/svg"><rect width="{w}" height="{h}" fill="none"/>'
                                colors = ['#007acc', '#4da6ff', '#99ccff']
                                cx, tcp = 0, 100 - miss_pct
                                
                                for i, t in enumerate(top_cats):
                                    bw = (t['pct'] * (tcp / 100) / 100) * w
                                    if bw > 0:
                                        svg += f'<rect x="{cx}" y="0" width="{bw}" height="{h}" fill="{colors[i % len(colors)]}" />'
                                        cx += bw
                                if other_pct > 0:
                                    bw = (other_pct * (tcp / 100) / 100) * w
                                    svg += f'<rect x="{cx}" y="0" width="{bw}" height="{h}" fill="#888888" />'
                                    cx += bw
                                if miss_pct > 0:
                                    bw = (miss_pct / 100) * w
                                    svg += f'<rect x="{cx}" y="0" width="{bw}" height="{h}" fill="#f14c4c" />'
                                svg += '</svg>'
                                res["svg"] = base64.b64encode(svg.encode('utf-8')).decode('utf-8')
                                
                            else:
                                stata.run(f"quietly capture summarize {var_name}, detail", inline=True)
                                mean_val = Scalar.getValue("r(mean)")
                                median_val = Scalar.getValue("r(p50)")
                                min_val = Scalar.getValue("r(min)")
                                max_val = Scalar.getValue("r(max)")
                                
                                def format_stat(val, format_str, is_d):
                                    if val is None or val > 8.9e307: return "N/A"
                                    if is_d:
                                        stata.run(f"quietly capture local f_val : display {format_str} {val}", inline=True)
                                        return Macro.getLocal("f_val").strip()
                                    return str(round(val, 2))
                                    
                                res["mean"] = format_stat(mean_val, fmt, False)
                                res["median"] = format_stat(median_val, fmt, is_date)
                                res["min"] = format_stat(min_val, fmt, is_date)
                                res["max"] = format_stat(max_val, fmt, is_date)
                                
                                has_neg, has_zero, mean_pos = False, False, 0
                                
                                if n_val > 0 and min_val is not None and max_val is not None:
                                    raw_vals = Data.get(var_name, obs_range)
                                    clean_vals = [val[0] if isinstance(val, (list, tuple)) else val for val in raw_vals]
                                    clean_vals = [x for x in clean_vals if x is not None and isinstance(x, (int, float)) and x < 8.9e307]
                                    
                                    if clean_vals:
                                        has_neg, has_zero = any(x < 0 for x in clean_vals), any(x == 0 for x in clean_vals)
                                        num_bins = 15
                                        bin_w = (max_val - min_val) / num_bins
                                        if bin_w <= 0: bin_w = 1
                                        
                                        counts = [0] * num_bins
                                        for cv in clean_vals:
                                            counts[min(int((cv - min_val) / bin_w), num_bins - 1)] += 1
                                        max_c = max(counts)
                                        
                                        if mean_val is not None and max_val > min_val:
                                            mean_pos = max(0, min(100, ((mean_val - min_val) / (max_val - min_val)) * 100))
                                            
                                        # Generate Histogram SVG for Numerics/Dates
                                        w, h = 300, 60
                                        svg = f'<svg width="{w}" height="{h}" xmlns="http://www.w3.org/2000/svg"><rect width="{w}" height="{h}" fill="none"/>'
                                        bar_w = w / num_bins
                                        gap = 0 if is_date else 1
                                        
                                        for i, c in enumerate(counts):
                                            bh = max(1, (c / max_c) * h) if max_c > 0 else 0
                                            bg = "#f14c4c" if is_date and c == 0 else "#3794ff"
                                            op = "0.3" if is_date and c == 0 else "1.0"
                                            if bh > 0 or is_date:
                                                svg += f'<rect x="{i * bar_w}" y="{h - bh}" width="{bar_w - gap}" height="{bh}" fill="{bg}" opacity="{op}" />'
                                                
                                        if mean_pos > 0 and not is_date:
                                            mx = (mean_pos / 100) * w
                                            svg += f'<line x1="{mx}" y1="0" x2="{mx}" y2="{h}" stroke="#f14c4c" stroke-width="2" />'
                                        svg += '</svg>'
                                        res["svg"] = base64.b64encode(svg.encode('utf-8')).decode('utf-8')
                                
                                res["has_neg"] = has_neg
                                res["has_zero"] = has_zero
                                
                        send_msg({"type": "hover_summary_result", "data": res, "req_id": req_id})
                    except Exception as e:
                        send_msg({"type": "hover_summary_result", "data": {"error": str(e)}, "req_id": req_id})
                else:
                    send_msg({"type": "hover_summary_result", "data": {"error": "No variable"}, "req_id": req_id})
                    
            elif cmd == "fetch_column_stats":
                vars_to_stat = req.get("variables", [])
                stats_res = {}
                try:
                    from pystata import stata
                    from sfi import Scalar, Data, Macro
                    import collections
                    
                    tot_obs = Data.getObsTotal()
                    with stata_lock:
                        for v in vars_to_stat:
                            idx = Data.getVarIndex(v)
                            fmt = Data.getVarFormat(idx)
                            is_str = fmt.startswith('%') and ('s' in fmt or 'S' in fmt)
                            # Stata date/time formats start with %t, %-t, or %d
                            is_date = fmt.startswith('%t') or fmt.startswith('%-t') or fmt.startswith('%d')
                            
                            stata.run(f"quietly capture count if !missing({v})", inline=True)
                            n_val = Scalar.getValue("r(N)")
                            if n_val is None or (isinstance(n_val, float) and n_val > 8.9e307): 
                                n_val = 0
                                
                            miss_pct = ((tot_obs - n_val) / tot_obs * 100) if tot_obs > 0 else 0
                            missing_str = f"{round(miss_pct, 1)}%"
                            
                            obs_range = [int(i * (tot_obs - 1) / 49999) for i in range(50000)] if tot_obs > 500000 else list(range(tot_obs))
                            
                            if is_str:
                                raw_vals = Data.get(v, obs_range)
                                clean_vals = [val[0] if isinstance(val, (list, tuple)) else val for val in raw_vals]
                                clean_vals = [x for x in clean_vals if x and str(x).strip()]
                                
                                unique_count = 0
                                top_cats = []
                                other_pct = 0
                                total_clean = len(clean_vals)
                                
                                if total_clean > 0:
                                    counter = collections.Counter(clean_vals)
                                    unique_count = len(counter)
                                    top_3 = counter.most_common(3)
                                    top_cats = [{"val": str(k), "count": c, "pct": (c/total_clean)*100} for k, c in top_3]
                                    other_pct = ((total_clean - sum(c for k, c in top_3)) / total_clean) * 100
                                
                                stats_res[v] = {
                                    "type": "string",
                                    "unique": unique_count,
                                    "top": top_cats,
                                    "other_pct": other_pct,
                                    "missing_pct": miss_pct,
                                    "missing_str": missing_str
                                }
                            else:
                                stata.run(f"quietly capture summarize {v}, detail", inline=True)
                                mean_val = Scalar.getValue("r(mean)")
                                median_val = Scalar.getValue("r(p50)")
                                min_val = Scalar.getValue("r(min)")
                                max_val = Scalar.getValue("r(max)")
                                
                                def format_stat(val, format_str, is_d):
                                    if val is None or val > 8.9e307: return "N/A"
                                    if is_d:
                                        stata.run(f"quietly capture local f_val : display {format_str} {val}", inline=True)
                                        return Macro.getLocal("f_val").strip()
                                    return round(val, 2)
                                
                                str_mean = format_stat(mean_val, fmt, False)
                                str_median = format_stat(median_val, fmt, is_date)
                                str_min = format_stat(min_val, fmt, is_date)
                                str_max = format_stat(max_val, fmt, is_date)
                                
                                bins = []
                                mean_pos = 0
                                has_neg, has_zero = False, False
                                
                                if n_val > 0 and min_val is not None and max_val is not None:
                                    raw_vals = Data.get(v, obs_range)
                                    clean_vals = [val[0] if isinstance(val, (list, tuple)) else val for val in raw_vals]
                                    clean_vals = [x for x in clean_vals if x is not None and isinstance(x, (int, float)) and x < 8.9e307]
                                    
                                    if clean_vals:
                                        has_neg = any(x < 0 for x in clean_vals)
                                        has_zero = any(x == 0 for x in clean_vals)
                                        
                                        num_bins = 15
                                        bin_w = (max_val - min_val) / num_bins
                                        if bin_w <= 0: bin_w = 1
                                        
                                        counts = [0] * num_bins
                                        for cv in clean_vals:
                                            counts[min(int((cv - min_val) / bin_w), num_bins - 1)] += 1
                                            
                                        max_c = max(counts)
                                        for i, c in enumerate(counts):
                                            b_min, b_max = min_val + (i * bin_w), min_val + ((i + 1) * bin_w)
                                            pct = (c / max_c * 100) if max_c > 0 else 0
                                            bins.append({"pct": pct, "count": c, "range": f"{format_stat(b_min, fmt, is_date)} to {format_stat(b_max, fmt, is_date)}"})
                                        
                                        if mean_val is not None and max_val > min_val:
                                            mean_pos = ((mean_val - min_val) / (max_val - min_val)) * 100
                                            mean_pos = max(0, min(100, mean_pos))
                                            
                                stats_res[v] = {
                                    "type": "date" if is_date else "numeric",
                                    "bins": bins, "mean_pos": mean_pos,
                                    "mean": str_mean, "median": str_median,
                                    "min": str_min, "max": str_max,
                                    "has_neg": has_neg, "has_zero": has_zero,
                                    "missing": missing_str
                                }
                                
                    send_msg({"type": "column_stats_result", "data": stats_res, "req_id": req_id})
                except Exception as e:
                    send_msg({"type": "column_stats_result", "data": {"error": str(e)}, "req_id": req_id})

        finally:
            task_queue.task_done()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--stata-path', type=str, default="")
    args, _ = parser.parse_known_args()

    stata_path = args.stata_path.strip().strip('"').strip("'")
    
    if stata_path:
        try:
            sys.path.append(os.path.join(stata_path, 'utilities'))
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

    worker_th = threading.Thread(target=worker_thread, daemon=True)
    worker_th.start()
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
            while not task_queue.empty():
                try:
                    task_queue.get_nowait()
                    task_queue.task_done()
                except queue.Empty:
                    break
            
            if worker_th and worker_th.ident:
                ctypes.pythonapi.PyThreadState_SetAsyncExc(ctypes.c_long(worker_th.ident), ctypes.py_object(KeyboardInterrupt))

            send_msg({"type": "output", "data": "\n[Stata Error]: Execution interrupted by user.\n", "req_id": req_id})
            send_msg({"type": "status", "data": "idle", "req_id": req_id})
        elif cmd == "exit":
            send_msg({"type": "output", "data": "\n--- Shutting down Stata engine ---\n", "req_id": req_id})
            break
        elif cmd in ["execute", "fetch_active", "validate_filter", "fetch_variables", "hover_summary", "find_ado", "profile_dataset", "fetch_column_stats"]:
            if cmd == "fetch_active" and "scrollToken" in req:
                global_state["latest_scroll_token"] = max(global_state["latest_scroll_token"], req["scrollToken"])
            task_queue.put(req)

if __name__ == "__main__":
    main()