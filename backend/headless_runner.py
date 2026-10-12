import sys
import os

def main():
    if len(sys.argv) < 3:
        print("Usage: headless_runner.py <stata_path> <do_file_path>")
        sys.exit(1)
        
    stata_path = sys.argv[1]
    do_file_path = sys.argv[2]
    
    try:
        sys.path.append(os.path.join(stata_path, 'utilities'))
        import stata_setup
        
        # Implement fallback logic for different Stata licenses
        try:
            stata_setup.config(stata_path, 'mp')
        except Exception:
            try:
                stata_setup.config(stata_path, 'se')
            except Exception:
                stata_setup.config(stata_path, 'ic')
                
        from pystata import stata
    except Exception as e:
        print(f"Failed to initialize Stata for background job: {e}")
        sys.exit(1)
    
    print(f"--- Starting Background Job ---")
    print(f"Executing: {os.path.basename(do_file_path)}")
    
    with open(do_file_path, 'r') as f:
        code = f.read()
        
    try:
        stata.run(code)
        print("\n--- Background Job Finished Successfully ---")
    except Exception as e:
        print(f"\n--- Background Job Failed ---")
        print(str(e))
        sys.exit(1)
    finally:
        try: os.remove(do_file_path)
        except: pass

if __name__ == "__main__":
    main()