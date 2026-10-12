import sys
import json
import pandas as pd
import numpy as np
import os
import sqlite3

sys.stdout.reconfigure(line_buffering=True)

def send_msg(msg_dict):
    print(json.dumps(msg_dict), flush=True)

def main():
    if len(sys.argv) < 2:
        send_msg({"type": "error", "data": "No file path provided."})
        return

    filepath = sys.argv[1]
    
    try:
        try:
            import pyreadstat
            has_pyreadstat = True
        except ImportError:
            has_pyreadstat = False

        if has_pyreadstat:
            try:
                _, meta = pyreadstat.read_dta(filepath, metadataonly=True)
                total = meta.number_rows
                columns = [{"name": str(col), "format": ""} for col in meta.column_names]
                send_msg({"type": "metadata", "total": total, "columns": columns})
                
                while True:
                    line = sys.stdin.readline()
                    if not line: break
                    
                    try:
                        req = json.loads(line)
                    except:
                        continue
                        
                    cmd = req.get("cmd")
                    req_id = req.get("req_id")
                    
                    if cmd == "fetch_chunk":
                        start = req.get("start", 0)
                        end = min(req.get("end", 100), total)
                        
                        chunk_df, _ = pyreadstat.read_dta(filepath, row_offset=start, row_limit=end-start)
                        chunk_df = chunk_df.replace({np.nan: "", pd.NaT: ""})
                        chunk_data = chunk_df.to_dict(orient="records")
                        
                        send_msg({
                            "type": "dataChunk",
                            "data": chunk_data,
                            "total": total,
                            "columns": columns,
                            "req_start": start,
                            "req_id": req_id
                        })
                return
            except Exception as e:
                pass 

        file_size_mb = os.path.getsize(filepath) / (1024 * 1024)
        if file_size_mb > 1500:
            send_msg({"type": "error", "data": f"The file '{os.path.basename(filepath)}' is {file_size_mb:.1f} MB. Please load it natively in Stata or install 'pyreadstat' (pip install pyreadstat) for memory-efficient loading."})
            return

        conn = sqlite3.connect(':memory:')
        itr = pd.read_stata(filepath, iterator=True, chunksize=100000)
        total = 0
        columns = []
        for i, chunk in enumerate(itr):
            if i == 0:
                columns = [{"name": str(col), "format": ""} for col in chunk.columns]
            chunk = chunk.replace({np.nan: "", pd.NaT: ""})
            chunk.to_sql('dta_table', conn, if_exists='append', index=False)
            total += len(chunk)
            
        send_msg({"type": "metadata", "total": total, "columns": columns})

        while True:
            line = sys.stdin.readline()
            if not line: break
            
            try: req = json.loads(line)
            except: continue
                
            cmd = req.get("cmd")
            req_id = req.get("req_id")
            
            if cmd == "fetch_chunk":
                start = req.get("start", 0)
                limit = min(req.get("end", 100), total) - start
                
                chunk_df = pd.read_sql_query(f"SELECT * FROM dta_table LIMIT {limit} OFFSET {start}", conn)
                chunk_data = chunk_df.to_dict(orient="records")
                
                send_msg({
                    "type": "dataChunk",
                    "data": chunk_data,
                    "total": total,
                    "columns": columns,
                    "req_start": start,
                    "req_id": req_id
                })
    except Exception as e:
        send_msg({"type": "error", "data": str(e)})

if __name__ == "__main__":
    main()