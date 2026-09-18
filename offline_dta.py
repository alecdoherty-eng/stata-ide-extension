import sys
import json
import pandas as pd
import numpy as np

sys.stdout.reconfigure(line_buffering=True)

def send_msg(msg_dict):
    print(json.dumps(msg_dict), flush=True)

def main():
    if len(sys.argv) < 2:
        send_msg({"type": "error", "data": "No file path provided."})
        return

    filepath = sys.argv[1]
    
    try:
        # Load the dta file using pandas. 
        # For massive files, chunksize could be implemented here later.
        itr = pd.read_stata(filepath, iterator=True)
        df = itr.read()
        
        # Replace NaNs/NaTs with empty strings for JSON serialization
        df = df.replace({np.nan: "", pd.NaT: ""})
        
        total = len(df)
        columns = [{"name": str(col), "format": ""} for col in df.columns]
        
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
                
                chunk_df = df.iloc[start:end]
                # Convert the chunk to a list of dicts
                chunk_data = chunk_df.to_dict(orient="records")
                
                send_msg({
                    "type": "dataChunk",
                    "data": chunk_data,
                    "total": total,
                    "columns": columns,
                    "req_id": req_id
                })
    except Exception as e:
        send_msg({"type": "error", "data": str(e)})

if __name__ == "__main__":
    main()