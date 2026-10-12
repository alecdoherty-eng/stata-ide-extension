from __future__ import print_function
from __future__ import unicode_literals
from pystata import config
import sys
import threading 
import time

def output_get_interactive_result(output, real_cmd, colon, mode):
    try:
        if mode==2:
            if colon:
                fmt_str1 = ". mata:\n"
            else:
                fmt_str1 = ". mata\n"
        else:
            if colon:
                fmt_str1 = ". python:\n"
            else:
                fmt_str1 = ". python\n"
		
        pos1 = output.index(fmt_str1)
        pos1 = pos1 + len(fmt_str1)
    except:
        pos1 = 0

    output = output[pos1:]

    try:
        if mode==2:
            fmt_str2 = "-"*49 + " mata (type end to exit) "
        else:
            fmt_str2 = "-"*47 + " python (type end to exit) "

        pos2 = output.index(fmt_str2)
        pos2 = output.index("\n") + 1
    except:
        pos2 = 0

    output = output[pos2:]

    try:
        fmt_str3 = real_cmd
        pos3 = output.index(fmt_str3)
        if pos3 != 0:
            pos3 = 0
        else:
            pos3 = pos3 + len(fmt_str3)
    except:
        pos3 = 0

    output = output[pos3:]

    try:
        if mode==2:
            fmt_str4 = ": end\n"
        else:
            fmt_str4 = ">>> end\n"
        pos4 = output.rindex(fmt_str4)
    except:
        pos4 = 0

    return output[:pos4]


class StataDisplay:
    def write(self, text):
        textList = text.split("\n")
        for t in textList[:-1]:
            config.stlib.StataSO_AppendOutputBuffer(config.get_encode_str(t))
            config.stlib.StataSO_AppendOutputBuffer(config.get_encode_str("\n"))
        config.stlib.StataSO_AppendOutputBuffer(config.get_encode_str(textList[-1]))

    def flush(self):
        pass


class StataError:
    def write(self, text):
        config.stlib.StataSO_AppendOutputBuffer(config.get_encode_str(text))

    def flush(self):
        pass

	
class RedirectOutput:
    """context manager for redirecting stdout/err"""

    def __init__(self, stdout='', stderr='', stecho=None):
        self.stdout = stdout
        self.stderr = stderr
        self.stecho = stecho

    def __enter__(self):
        self.sys_stdout = sys.stdout
        self.sys_stderr = sys.stderr

        if self.stdout:
            sys.stdout = self.stdout
        if self.stderr:
            if self.stderr == self.stdout:
                sys.stderr = sys.stdout
            else:
                sys.stderr = self.stderr
                
        if self.stecho is False:
            config.stlib.StataSO_Execute(config.get_encode_str("set showcommand off"), False)

    def __exit__(self, exc_type, exc_value, traceback):
        sys.stdout = self.sys_stdout
        sys.stderr = self.sys_stderr
        
        if self.stecho is False:
            config.stlib.StataSO_Execute(config.get_encode_str("set showcommand on"), False)

def _print_streaming_output(output, newline):
    if config.pyversion[0] >= 3:
        if newline:
            print(output, flush=True, file=config.stoutputf)
        else:
            print(output, end='', flush=True, file=config.stoutputf)
    else:
        if newline:
            print(config.get_encode_str(output), file=config.stoutputf)
        else:
            print(config.get_encode_str(output), end='', file=config.stoutputf)

        sys.stdout.flush()


class RepeatTimer(threading.Thread):
    def __init__(self, tname, otype, queue, interval, real_cmd, colon, mode, callback):       
        threading.Thread.__init__(self, name=tname)
        self.q = queue
        self.otype = otype
        self.interval = interval
        self.is_done = False
        self.old_stdout = sys.stdout
        self.old_stderr = sys.stderr
        self.real_cmd = real_cmd
        self.colon = colon
        self.mode = mode
        self.callback = callback

    def done(self):
        sys.stdout = self.old_stdout
        sys.stderr = self.old_stderr
        self.is_done = True

    def run(self):
        while not self.is_done:
            self.sys_stdout = sys.stdout
            self.sys_stderr = sys.stderr
            sys.stdout = self.old_stdout
            sys.stderr = self.old_stderr
            output = config.get_output()
            if self.q.empty():
                if len(output)!=0:
                    if self.mode!=1 and self.otype==2:
                        output = output_get_interactive_result(output, self.real_cmd, self.colon, self.mode)
                    
                    _print_streaming_output(output, False)
            else:
                rc = self.q.get()
                self.done()
                if rc == 0:
                    if self.otype==1:
                        if len(output)!=0:
                            _print_streaming_output(output, False)    
                    else:
                        if self.mode!=1:
                            output = output_get_interactive_result(output, self.real_cmd, self.colon, self.mode)
                            _print_streaming_output(output, False)
                        else:
                            _print_streaming_output(output, True)
                else:
                    if self.otype==1:
                        if self.callback is not None and len(self.callback) > 0:
                            self.callback.clear()
                        self.callback.append(output)
                        return
                    else:
                        if rc!=3000:
                            if self.mode!=1:
                                output = output_get_interactive_result(output, self.real_cmd, self.colon, self.mode)
                                _print_streaming_output(output, False)
                            else:
                                if self.callback is not None and len(self.callback) > 0:
                                    self.callback.clear()
                                self.callback.append(output)
                                return
                                

            sys.stdout = self.sys_stdout
            sys.stderr = self.sys_stderr
            time.sleep(self.interval)
