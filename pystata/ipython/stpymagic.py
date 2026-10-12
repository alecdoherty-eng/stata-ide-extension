from __future__ import absolute_import, print_function
import os
import shlex

import sys
import math
import webbrowser

from pystata import config as _config
from pystata.stexception import IPythonError, IPyKernelError

try:
    from IPython.core.magic import (Magics, magics_class, line_cell_magic, needs_local_scope, line_magic)
    from pystata.ipython.ipy_utils import get_ipython_stata_cache_dir
except ImportError:
    _config.stipython = 1
    raise IPythonError('failed to import IPython package')

from pystata import stata as _stata

if not _stata.has_num_pand['pknum']: 
    _config.stipython = 3
elif not _stata.has_num_pand['pkpand']:
    _config.stipython = 4

if _stata.has_num_pand['pknum']: 
    import numpy as np

if _stata.has_num_pand['pkpand']:
    import pandas as pd
    from pystata.core import numpy2mata as _mata

from IPython import get_ipython


def _parse_arguments(inopts, allowopts, magicname):
    res = {}
    errmsg = 'Type ' + magicname + ' to get more information.'

    opts = shlex.split(inopts, posix=False)

    olen = len(opts)
    if olen==0:
        return res

    i = 0
    while i < olen:
        if opts[i][0]=='-' and ':' in opts[i]:
            raise SyntaxError('option ' + opts[i] + ' not allowed. ' + errmsg)

        if i==(olen-1):
            if opts[i] in allowopts:
                res[opts[i]] = ''
                i += 1
            else:
                tmp = opts[i] + ':'
                if tmp in allowopts:
                    raise SyntaxError('A value is required for option ' + opts[i] + '. ' + errmsg)
                else:
                    raise SyntaxError('option ' + opts[i] + ' not allowed. ' + errmsg)
        else:
            if opts[i] in allowopts:
                if opts[i+1][0] != '-':
                    raise SyntaxError('option ' + opts[i] + ' misspecified. ' + errmsg)
                else:
                    res[opts[i]] = ''
                    i += 1
            else:
                tmp = opts[i] + ':'
                if tmp in allowopts:
                    if opts[i+1][0] == '-':
                        raise SyntaxError('option ' + opts[i] + ' misspecified. ' + errmsg)
                    else:
                        res[opts[i]] = opts[i+1]
                        i += 2
                else:
                    raise SyntaxError('option ' + opts[i] + ' not allowed. ' + errmsg)				

    return res


def _get_input_type(o):
    if _stata.has_num_pand['pknum']: 
        if isinstance(o, np.ndarray):
            return 1 
        
    if _stata.has_num_pand['pkpand']: 
        if isinstance(o, pd.DataFrame):
            return 2
	    
    return 0


@magics_class
class PyStataMagic(Magics):

    def __init__(self, shell):
        super(PyStataMagic, self).__init__(shell)
        self._lib_dir = os.path.join(get_ipython_stata_cache_dir(), 'stata')
        if not os.path.exists(self._lib_dir):
            os.makedirs(self._lib_dir)

    @needs_local_scope
    @line_cell_magic
    def stata(self, line, cell=None, local_ns=None):
        '''
        Execute one line or a block of Stata commands.

        When the line magic command %stata is used, a one-line Stata 
        command can be specified and executed, as it would be in Stata's 
        Command window. When the cell magic command %%stata is used, a 
        block of Stata commands can be specified and executed all at once. 
        This is similar to executing a series of commands from a do-file.

        Cell magic syntax:

            %%stata [-d DATA] [-f DFLIST|ARRLIST] [-force]
             [-doutd DATAFRAME] [-douta ARRAY] [-foutd FRAMELIST] [-fouta FRAMELIST]
             [-ret DICTIONARY] [-eret DICTIONARY] [-sret DICTIONARY] [-qui] [-nogr]
             [-gw WIDTH] [-gh HEIGHT]

            Optional arguments:

              -d DATA               Load a NumPy array or pandas dataframe 
                                    into Stata as the current working dataset.

              -f DFLIST|ARRLIST     Load one or multiple NumPy arrays or 
                                    pandas dataframes into Stata as frames. 
                                    The arrays and dataframes should be 
                                    separated by commas. Each array or 
                                    dataframe is stored in Stata as a separate 
                                    frame with the same name.

              -force                Force loading of the NumPy array or pandas 
                                    dataframe into Stata as the current working 
                                    dataset, even if the dataset in memory has 
                                    changed since it was last saved; or force 
                                    loading of the NumPy arrays or pandas dataframes 
                                    into Stata as separate frames even if one or 
                                    more of the frames already exist in Stata.

              -doutd DATAFRAME      Save the dataset in memory as a pandas 
                                    dataframe when the cell completes.

              -douta ARRAY          Save the dataset in memory as a NumPy 
                                    array when the cell completes.

              -foutd FRAMELIST      Save one or multiple Stata frames as pandas 
                                    dataframes when the cell completes. The Stata 
                                    frames should be separated by commas. Each 
                                    frame is stored in Python as a pandas 
                                    dataframe. The variable names in each frame 
                                    will be used as the column names in the 
                                    corresponding dataframe. 

              -fouta FRAMELIST      Save one or multiple Stata frames as NumPy 
                                    arrays when the cell completes. The Stata frames 
                                    should be separated by commas. Each frame is 
                                    stored in Python as a NumPy array.

              -ret DICTIONARY       Store current r() results into a dictionary.

              -eret DICTIONARY      Store current e() results into a dictionary.
 
              -sret DICTIONARY      Store current s() results into a dictionary.

              -qui                  Run Stata commands but suppress output.

              -nogr                 Do not display Stata graphics.

              -gw WIDTH             Set graph width in inches, pixels, or centimeters; 
                                    default is inches.

              -gh HEIGHT            Set graph height in inches, pixels, or centimeters; 
                                    default is inches.

              -nocmd                Do not display the commands in the output.


        Line magic syntax:

            %stata stata_cmd
            
            
        '''
        if cell is None:
            if not line:
                raise SyntaxError("Stata command required")

            _stata.run(line)
            return

        allowopts = ['-d:', '-f:', '-force', '-doutd:', '-douta:', '-foutd:', '-fouta:', '-ret:', '-eret:', '-sret:', '-qui', '-nogr', '-gw:', '-gh:', '-nocmd']
        args = _parse_arguments(line, allowopts, '%%stata?')

        if local_ns is None:
            local_ns = {}

        force_to_load = False
        if '-force' in args:
            force_to_load = True

        if '-d' in args:
            if not _stata.has_num_pand['pknum'] and not _stata.has_num_pand['pkpand']:
                raise SystemError('NumPy package or pandas package is required to use this argument.')

            data = args['-d']
            try:
                val = local_ns[data]
            except KeyError:
                try:
                    val = self.shell.user_ns[data]
                except KeyError:
                    raise NameError("name '%s' is not defined" % data)

            
            input_dtype = _get_input_type(val)
            if input_dtype > 0:
                try:
                    if input_dtype==2:
                        _stata.pdataframe_to_data(val, force=force_to_load)
                    else:
                        _stata.nparray_to_data(val, force=force_to_load)
                except SystemError:
                    raise
                except:
                    raise SystemError("Exception occurred. Data could not be loaded.")
            else:
                raise TypeError("A pandas dataframe or NumPy array is required.")

        if '-f' in args:
            if not _stata.has_num_pand['pknum'] and not _stata.has_num_pand['pkpand']:
                raise SystemError('NumPy package or pandas package is required to use this argument.')

            frames = args['-f'].replace("'", '').replace('"', '').split(',')
            for fr in frames:
                try:
                    frval = local_ns[fr]
                except KeyError:
                    try:
                        frval = self.shell.user_ns[fr]
                    except KeyError:
                        raise NameError("name '%s' is not defined" % fr)

                input_ftype = _get_input_type(frval)
                if input_ftype==0:
                    raise TypeError("%s is not a pandas dataframe or NumPy array. Only dataframe or array is allowed." % fr)

            for fr in frames:
                try:
                    frval = local_ns[fr]
                except KeyError:
                    frval = self.shell.user_ns[fr]

                input_ftype = _get_input_type(frval)
                try:
                    if input_ftype==2:
                        _stata.pdataframe_to_frame(frval, fr, force=force_to_load)
                    else:
                        _stata.nparray_to_frame(frval, fr, force=force_to_load)
                except SystemError:
                    raise
                except:
                    raise SystemError("Exception occurred. %s could not be loaded." % fr)


        if '-gw' in args or '-gh' in args:
            gwidth = _config.get_graph_size_str('gw')
            gheight = _config.get_graph_size_str('gh')
            if '-gw' in args and '-gh' in args:
                _config.set_graph_size(args['-gw'], args['-gh'])
            elif '-gw' in args:
                _config.set_graph_size(args['-gw'], None)
            else:
                _config.set_graph_size(None, args['-gh'])

        if '-nogr' in args:
            grshow = _config.stconfig['grshow']
            _config.set_graph_show(False)

        if '-nocmd' in args:
            echo = False 
        else:
            echo = None        

        if '-qui' in args:
            _stata.run(cell, quietly=True, echo=echo, inline=_config.stconfig['grshow'])
        else:
            _stata.run(cell, quietly=False, echo=echo, inline=_config.stconfig['grshow'])

        if '-gw' in args or '-gh' in args:
            _config.set_graph_size(gwidth, gheight)

        if '-nogr' in args:
            _config.set_graph_show(grshow)

        if '-ret' in args or '-eret' in args or '-sret' in args:
            if '-ret' in args:
                val = _stata.get_return()
                self.shell.push({args['-ret']: val })

            if '-eret' in args:
                val = _stata.get_ereturn()
                self.shell.push({args['-eret']: val })

            if '-sret' in args:
                val = _stata.get_sreturn()
                self.shell.push({args['-sret']: val })

        if '-doutd' in args:
            if not _stata.has_num_pand['pkpand']:
                raise SystemError('pandas package is required to use this argument.')

            try:
                output_df = _stata.pdataframe_from_data()
                self.shell.push({args['-doutd']: output_df })
            except:
                print("Exception occurred. Data could not be written to the dataframe.")

        if '-douta' in args:
            if not _stata.has_num_pand['pknum']:
                raise SystemError('NumPy package is required to use this argument.')

            try:
                output_arr = _stata.nparray_from_data()
                self.shell.push({args['-douta']: output_arr })
            except:
                print("Exception occurred. Data could not be written to the array.")

        if '-foutd' in args:
            if not _stata.has_num_pand['pkpand']:
                raise SystemError('pandas package is required to use this argument.')

            frames = args['-foutd'].replace("'", '').replace('"', '').split(',')
            output_dfs = {}
            for fr in frames:
                try:
                    output_df = _stata.pdataframe_from_frame(fr)
                    output_dfs[fr] = output_df
                except:
                    raise SystemError("Exception occurred. Stata's frame %s could not be saved to a pandas dataframe." % fr)

            self.shell.push(output_dfs)    

        if '-fouta' in args:
            if not _stata.has_num_pand['pknum']:
                raise SystemError('NumPy package is required to use this argument.')

            frames = args['-fouta'].replace("'", '').replace('"', '').split(',')
            output_arrs = {}
            for fr in frames:
                try:
                    output_arr = _stata.nparray_from_frame(fr)
                    output_arrs[fr] = output_arr
                except:
                    raise SystemError("Exception occurred. Stata's frame %s could not be saved to a NumPy array." % fr)

            self.shell.push(output_arrs)   


    @needs_local_scope
    @line_cell_magic
    def mata(self, line, cell=None, local_ns=None):
        '''
        Execute one line or a block of Mata code.

        When the %mata line magic command is used, one line of Mata code 
        can be specified and executed. This is similar to specifying 
        mata: istmt within Stata. When the %%mata cell magic command is 
        used, a block of Mata code can be specified. The code is executed just 
        as it would be in a do-file.

        Cell magic syntax:

            %%mata [-m ARRAYLIST] [-outm MATLIST] [-qui] [-c] 

              Execute a block of Mata code. This is equivalent to running a 
              block of Mata code within a do-file. You do not need to 
              explicitly place the code within the mata[:] and end block. 
			
              Optional arguments:

                -m ARRAYLIST      Load multiple NumPy arrays into Mata's 
                                  interactive environment. The array names 
                                  should be separated by commas. Each array is 
                                  stored in Mata as a matrix with the same name.

                -outm MATLIST     Save Mata matrices as NumPy arrays when the 
                                  cell completes. The matrix names should be
                                  separated by commas. Each matrix is stored 
                                  in Python as a NumPy array.

                -qui              Run Mata code but suppress output.

                -c                This argument specifies that Mata code be 
                                  executed in mata: mode. This means that
                                  if Mata encounters an error, it will stop 
                                  execution and return control to Python. The 
                                  error will then be thrown as a Python SystemError 
                                  exception.


        Line magic syntax:

            %mata [-c]
			
              Enter Mata's interactive environment. This is equivalent to 
              typing mata or mata: in the Stata Command window.

              Optional argument:

                -c                Enter interactive Mata environment in mata:
                                  mode. The default is to enter in mata mode.

            %mata istmt 

              Run a single-line Mata statement. This is equivalent to executing 
              mata: istmt within Stata.
              
              
        '''
        if cell is None:
            if not line:
                stcmd = "mata"
            elif line=='-c':
                stcmd = 'mata:'
            else:
                stcmd = "mata: " + line

            _stata.run(stcmd, inline=False)
        else:
            allowopts = ['-qui', '-c', '-m:', '-outm:']
            args = _parse_arguments(line, allowopts, '%%mata?')

            if local_ns is None:
                local_ns = {}

            if '-m' in args:
                if not _stata.has_num_pand['pknum']:
                    raise SystemError('NumPy package is required to use this argument.')
		    
                mats = args['-m'].replace("'", '').replace('"', '').split(',')
                for m in mats:
                    try:
                        mval = local_ns[m]
                    except KeyError:
                        try:
                            mval = self.shell.user_ns[m]
                        except KeyError:
                            raise NameError("name '%s' is not defined" % m)

                for m in mats:
                    try:
                        mval = local_ns[m]
                    except KeyError:
                        mval = self.shell.user_ns[m]

                    try:
                        _mata.array_to_mata(mval, m)
                    except:
                        print("Exception occurred. Array %s could not be loaded." % m)


            if cell[-1:] != '\n':
                cell = cell + '\n'

            if '-c' in args:
                cell = "mata:\n" + cell + "end"
            else:
                cell = "mata\n" + cell + "end"

            if '-qui' in args:
                _stata.run(cell, quietly=True, inline=False)
            else:
                _stata.run(cell, inline=False)


            if '-outm' in args:
                if not _stata.has_num_pand['pknum']:
                    raise SystemError('NumPy package is required to use this argument.')

                mats = args['-outm'].replace("'", '').replace('"', '').split(',')
                output_arrs = {}
                for m in mats:
                    try:
                        output_arr = _mata.array_from_mata(m)
                        output_arrs[m] = output_arr
                    except:
                        print("Exception occurred. Mata matrix %s could not be written to a NumPy array." % m)

                self.shell.push(output_arrs)


    @line_magic
    def pystata(self, line):
        '''
        Stata utility commands.

        Line magic syntax:

            %pystata status

              Display current system information and settings.


            %pystata set graph_show True|False [, perm]

              Set whether Stata graphics are displayed. The default is to 
              display the graphics. Note that if multiple graphs are 
              generated, only the last one is displayed. To display multiple
              graphs, use the name() option with Stata's graph commands.


            %pystata set graph_size w #[in|px|cm] [, perm]  
            %pystata set graph_size h #[in|px|cm] [, perm]
            %pystata set graph_size w #[in|px|cm] h #[in|px|cm] [, perm]

              Set dimensions for Stata graphs. The default is a 7.5-inch width 
              and 4.5-inch height. Values may be specified in inches, pixels, or 
              centimeters; the default unit is inches. Either the width or height 
              must be specified, or both. If only one is specified, the other one 
              is determined by the aspect ratio.		  


            %pystata set graph_format svg|png|pdf [, perm]

              Set the graphic format used to display Stata graphs. The default 
              is svg. If svg or png is specified, the graphs will be embedded. 
              If pdf is specified, the graphs will be displayed, and exported 
              to PDF files and stored in the current working directory with 
              numeric names, such as 0.pdf, 1.pdf, 2.pdf, etc. Storing the PDF 
              graph files in the current directory allows you to embed them in 
              the notebook when exporting the notebook to a PDF via Latex.


            %pystata set command_show True|False|default [, perm]

              Set whether to echo the commands in the output. True specifies 
              that the commands to be executed be shown along with the output. 
              False specifies that the commands not be shown in the output. 
              default specifies that when a single-line Stata command is 
              specified in the run() function of the stata module, or with 
              either the %stata line magic command or the %%stata cell magic 
              command, only the output is displayed; when a block of Stata 
              commands is specified, each command and its output are displayed 
              in sequence.


            %pystata set autocompletion on|off [, perm]

              Set whether to enable or disable autocompletion of Stata's 
              variable names, macro names, r() results, e() results,  
              and s() results from the current Stata session. on, the default, 
              specifies that autocompletion be enabled; simply press the Tab key 
              to use the autocompletion feature. off disables autocompletion.


            %pystata set streaming_output on|off [, perm]

              Set whether to display Stata's output while Stata is executing. 
              on, the default, specifies that the output be displayed 
              simultaneously while Stata is executing the code. off specifies 
              that Stata's output be displayed after Stata finishes execution. 
              
              
        '''
        if line is None:
            raise SyntaxError('subcommand required')

        scmd = line.strip().split(',')
        if len(scmd)>=3:
            raise SyntaxError('invalid syntax')

        sperm = False
        sopt = scmd[1].strip() if len(scmd)==2 else ""
        if sopt!="":
            if sopt not in ["perm", "perma", "perman", "permane", "permanen", "permanent", "permanentl", "permanently"]:
                raise SyntaxError('option ' + sopt + ' not allowed')
            else:
                sperm = True

        scmd = scmd[0].strip().split()
        slen = len(scmd)
        if slen==0:
            raise SyntaxError('subcommand required')

        subcmd = scmd[0]
        if subcmd=='help':
            if slen!=1:
                topic = ' '.join(scmd[1:])
            else:
                topic = 'help_advice'

            _stata.run('help ' + topic, inline=False)
        elif subcmd=='status':
            if slen!=1:
                raise SyntaxError(' '.join(scmd[1:]) + ' not allowed')
            else:
                _config.status()
        elif subcmd=='set':
            if slen==1:
                raise SyntaxError('set type must be specified')

            sset = scmd[1:]
            settype = sset[0]
            if settype=="graph_size":
                if len(sset)!=3 and len(sset)!=5:
                    raise ValueError('invalid graph_size set')

                if len(sset)==3:
                    if sset[1]=='width' or sset[1]=='w':
                        _config.set_graph_size(width=sset[2], height=None, perm=sperm)
                    elif sset[1]=='height' or sset[1]=='h':
                        _config.set_graph_size(width=None, height=sset[2], perm=sperm)
                    else:
                        raise ValueError('invalid graph_size value')
                else:
                    if (sset[1]=='width' or sset[1]=='w') and (sset[3]=='height' or sset[3]=='h'):
                        _config.set_graph_size(width=sset[2], height=sset[4], perm=sperm)
                    elif (sset[1]=='height' or sset[1]=='h') and (sset[3]=='width' or sset[3]=='w'):
                        _config.set_graph_size(width=sset[4], height=sset[2], perm=sperm)
                    else:
                        raise ValueError('invalid graph_size value')
            elif settype=="graph_show":
                if len(sset)!=2:
                    raise SyntaxError('invalid graph_show set; only True or False allowed.')

                if sset[1]=='True':
                    _config.set_graph_show(show=True, perm=sperm)
                elif sset[1]=='False':
                    _config.set_graph_show(show=False, perm=sperm)
                else:
                    raise ValueError('invalid graph_show value')
            elif settype=="graph_format":
                if len(sset)!=2:
                    raise SyntaxError('invalid graph_format set')

                if sset[1]=='svg':
                    _config.set_graph_format(gformat='svg', perm=sperm)
                elif sset[1]=='png':
                    _config.set_graph_format(gformat='png', perm=sperm)
                elif sset[1]=='pdf':
                    _config.set_graph_format(gformat='pdf', perm=sperm)
                else:
                    raise ValueError('invalid graph_format value; only svg, png, or pdf allowed.')
            elif settype=="streaming_output_mode" or settype=="streaming_output":
                if len(sset)!=2:
                    raise SyntaxError('invalid streaming_output set; only on or off allowed.')

                if sset[1]=='on':
                    _config.set_streaming_output_mode(flag='on', perm=sperm)
                elif sset[1]=='off':
                    _config.set_streaming_output_mode(flag='off', perm=sperm)
                else:
                    raise ValueError('invalid streaming_output_mode value; only on or off allowed.')
            elif settype=="command_show":
                if len(sset)!=2:
                    raise SyntaxError('invalid command_show set; only True or False allowed.')

                if sset[1]=='True':
                    _config.set_command_show(show=True, perm=sperm)
                elif sset[1]=='False':
                    _config.set_command_show(show=False, perm=sperm)
                elif sset[1]=='default':
                    _config.set_command_show(show='default', perm=sperm)
                else:
                    raise ValueError('invalid set_command_show value')
            elif settype=="autocompletion":
                if len(sset)!=2:
                    raise SyntaxError('invalid autocompletion set')

                if sset[1]=='on':
                    _config.set_autocompletion(flag='on', perm=sperm)
                elif sset[1]=='off':
                    _config.set_autocompletion(flag='off', perm=sperm)
                else:
                    raise ValueError('invalid autocompletion value; only on or off allowed.')
            else:
                raise SyntaxError('invalid set type')
        else:
            raise SyntaxError('invalid subcommand')

    @line_magic
    def help(self, line):
        '''
        View the help information about the specified Stata command or topic in 
        the web browser.

        Line magic syntax:

            %help [command_or_topic_name]
            
              This works like typing the help command in Stata to get help 
              for a specific command or topic. Instead of showing the help 
              directly in Stata, a browser is opened to get help from www.stata.com.
              
              
        '''
            
        if line is None:
            raise SyntaxError("Stata command required")

        if line.strip() == "":
            help_keyword = "help_advice"
        else:
            help_keyword = '_'.join(line.split())
            
        help_keyword = help_keyword.replace("##", "#")
            
        help_base = "https://www.stata.com"
    
        stversion = int(math.floor(float(_config.stversion)))
        help_cgi = "help" + str(stversion) + ".cgi?"
        
        
        if sys.version_info[0] < 3:
            import urllib2 
            
            help_url = urllib2.urlparse.urljoin(help_base, help_cgi + "{}")    
            webbrowser.open(help_url.format(help_keyword), new=2)          
        else:
            import urllib
            
            help_url = urllib.parse.urljoin(help_base, help_cgi + "{}")    
            webbrowser.open(help_url.format(help_keyword), new=2)


try:
    ip = get_ipython()
    ip.register_magics(PyStataMagic)
except AttributeError:
    _config.stipython = 2
    raise IPyKernelError('register_magics not found')


try:
    if _config.stconfig['autocomplete'] == 'on':
        from pystata.ipython.completer import load_stata_completers
        load_stata_completers(ip)
except:
    pass

