'''
    Autocompletion for Stata variables, local and global macros, 
    and scalars
'''

import re
from sfi import Data, Macro, SFIToolkit
from pystata import stata, config

def load_stata_completers(ip):
    def parse_code(code):
        tokens = code.split()
        n = len(tokens)
        if n == 0:
            return None, "" 
            
        m = re.search(r'^.*`(?P<token>\w+)?$', code)
        if m is not None:
            if m.group('token') is not None:
                return "local", m.group('token'), "'"
            else:
                return "local", "", "'"
                
        m = re.search(r'^.*\$(?P<token>\w+)?$', code)
        if m is not None:
            if m.group('token') is not None:
                return "global", m.group('token'), ""
            else:
                return "global", "", ""
            
        m = re.search(r'^.*\$\{\s*(?P<token>\w+)?$', code)
        if m is not None:
            if m.group('token') is not None:
                return "global", m.group('token'), "}"
            else:
                return "global", "", "}"
            
        m = re.search(r'^.*sca(lar|la|l)?\s+(?P<token>\w+)?$', code)
        if m is not None:
            if m.group('token') is not None:
                return "scalar", m.group('token'), ""
            else:
                return "scalar", "", ""
            
        m = re.search(r'^.*scalar\(\s*(?P<token>\w+)?$', code)
        if m is not None:
            if m.group('token') is not None:
                return "scalar", m.group('token'), ")"
            else:
                return "scalar", "", ")"

        m = re.search(r'[\s+|`?|={1,2}]r\((?P<token>\s*\w+)?$', code)
        if m is not None:
            if m.group('token') is not None:
                return "r()", m.group('token').strip()
            else:
                return "r()", ""

        m = re.search(r'[\s+|`?|={1,2}]e\((?P<token>\s*\w+)?$', code)
        if m is not None:
            if m.group('token') is not None:
                return "e()", m.group('token').strip()
            else:
                return "e()", ""
                
        m = re.search(r'[\s+|`?|={1,2}]s\((?P<token>\s*\w+)?$', code)
        if m is not None:
            if m.group('token') is not None:
                return "s()", m.group('token').strip()
            else:
                return "s()", ""
        
        if '.' in tokens[-1]:
            m = re.match(r'(.*#{0,2})(\w+)\.(\w*)$', tokens[-1])
            if m is not None:
                return "fvvarlist", m.group(3), m.group(2)
            else:
                m = re.search(r'(?P<token>\w+)?$', tokens[-1])
                if m is not None:
                    if m.group('token') is not None:
                        return "varlist", m.group('token')            
        else:
            m = re.search(r'(?P<token>\w+)?$', tokens[-1])
            if m is not None:
                if m.group('token') is not None:
                    return "varlist", m.group('token')
        
        return None, "" 
    
    def stata_get_varlist(token):
        """
        Stata variable completer. 
        """
        suggestions = [Data.getVarName(i) for i in range(Data.getVarCount())]
        return [v for v in suggestions if v.startswith(token)]

    def stata_get_fvvarlist(token, prefix):
        """
        Stata factor variable completer. 
        """
        suggestions = [Data.getVarName(i) for i in range(Data.getVarCount())]
        return [prefix+"."+v for v in suggestions if v.startswith(token)] 
        
    def stata_get_global(token, suffix):
        """
        global macro completer. 
        """
        cmd = 'local stglobals: disp `"`:all globals' + "'" + '"' + "'"
        SFIToolkit.stata(cmd, echo=False)
        suggestions = Macro.getLocal("stglobals").split()
        if "S_FLAVOR" in suggestions:
            suggestions.remove("S_FLAVOR")
        SFIToolkit.stata('local stglobals', echo=False)
    
        return [g + suffix for g in suggestions if g.startswith(token)]
        
    def stata_get_local(token, suffix):
        """
        local macro completer. 
        """
        cmd = "capture mata: st_local(" + '"stlocals", invtokens(st_dir("local", "macro", "*")' + "'))"
        SFIToolkit.stata(cmd, echo=False)
        suggestions = Macro.getLocal("stlocals").split()

        SFIToolkit.stata('local stlocals', echo=False)
        
        return [l + suffix for l in suggestions if l.startswith(token)]
        
    def stata_get_scalar(token, suffix):
        """
        scalar completer. 
        """
        cmd = 'local stscalars: disp `"`:all scalars' + "'" + '"' + "'"
        SFIToolkit.stata(cmd, echo=False)
        suggestions = Macro.getLocal("stscalars").split()
        SFIToolkit.stata('local stscalars', echo=False)
        
        return [s + suffix for s in suggestions if s.startswith(token)]
        
    def stata_get_return(token):
        """
        r() stored results completer. 
        """
        suggestions = list(stata.get_return().keys())
        suggestions = [s[2:-1] for s in suggestions]
        return [l for l in suggestions if l.startswith(token)]
        
    def stata_get_ereturn(token):
        """
        e() stored results completer. 
        """
        suggestions = list(stata.get_ereturn().keys())
        suggestions = [s[2:-1] for s in suggestions]
        return [l for l in suggestions if l.startswith(token)]
        
    def stata_get_sreturn(token):
        """
        s() stored results completer. 
        """
        suggestions = list(stata.get_sreturn().keys())
        suggestions = [s[2:-1] for s in suggestions]
        return [l for l in suggestions if l.startswith(token)]
        
    def stata_arg_completer(self, event):
        """
        %%stata magic argument completer. 
        """
        if config.stconfig['autocomplete'] == 'off':
            return[] 
            
        symbol = event.symbol 
        if symbol.startswith('-'):
            suggestions = ['-d', '-f', '-force', '-doutd', '-douta', \
                '-foutd', '-fouta', '-ret', '-eret', '-sret', '-qui', \
                '-nogr', '-gw', '-gh', '-nocmd']
            return [s for s in suggestions if s.startswith(symbol)]
    
        return []
        
    def stata_completer(self, event):
        """
        Stata auto-completion. 
        """
        if config.stconfig['autocomplete'] == 'off':
            return[] 
            
        line = event.line.lstrip()
        if line.startswith("%%stata") or line.startswith("%%mata") or \
            line.startswith("%pystata"):
            return[]
        
        code = event.text_until_cursor.lstrip()
        res = parse_code(code)
        token_type = res[0]
        token = res[1]
        if token_type is not None:
            if token_type == 'varlist':
                return stata_get_varlist(token)
            if token_type == 'fvvarlist':
                return stata_get_fvvarlist(token, res[2])
            if token_type == 'local':
                return stata_get_local(token, res[2])
            if token_type == 'global':
                return stata_get_global(token, res[2])
            if token_type == 'scalar':
                return stata_get_scalar(token, res[2])
            if token_type == 'r()':
                return stata_get_return(token)
            if token_type == 'e()':
                return stata_get_ereturn(token)
            if token_type == 's()':
                return stata_get_sreturn(token)

        return []
        
    def mata_arg_completer(self, event):
        """
        %%mata magic argument completer. 
        """
        if config.stconfig['autocomplete'] == 'off':
            return[] 
            
        symbol = event.symbol 
        if symbol.startswith('-'):
            suggestions = ['-m', '-outm', '-qui', '-c']
            return [s for s in suggestions if s.startswith(symbol)]
    
        return []
        
    def pystata_arg_completer(self, event):
        """
        %pystata magic argument completer. 
        """
        if config.stconfig['autocomplete'] == 'off':
            return[] 
            
        symbol = event.symbol 
        line = event.line 
    
        if symbol == '':
            return []
        
        lines = line.split()
        if len(lines) <= 2:
            suggestions = ['status', 'set']
            return [s for s in suggestions if s.startswith(symbol)]
        elif len(lines) <= 3:
            if lines[1] == 'set':
                suggestions = ['graph_format', 'graph_show', 'graph_size', 'command_show', 'autocompletion', 'streaming_output']
                return [s for s in suggestions if s.startswith(symbol)]
    
        return []
    
    ip.set_hook('complete_command', stata_arg_completer, str_key='%%stata')
    ip.set_hook('complete_command', stata_completer, re_key='.*')
    ip.set_hook('complete_command', mata_arg_completer, str_key='%%mata')
    ip.set_hook('complete_command', pystata_arg_completer, str_key='%pystata')
