'''
This module contains core functions used to interact with Stata.
'''
from __future__ import print_function
from ctypes import c_char_p, c_void_p, cast

from pystata import config
config.check_initialized()

if config.pyversion[0]<3:
    from Queue import LifoQueue
    from codecs import open
else:
    from queue import LifoQueue

import sfi
from pystata.core import stout
import codeop
import sys

rc2 = 0
gr_display_func = None
has_num_pand = {
    "pknum":  True,
    "pkpand": True
}

try:
    from pystata.core import numpy2stata
except:
    has_num_pand['pknum'] = False

try:
    from pystata.core import pandas2stata
except:
    has_num_pand['pkpand'] = False


def _print_no_streaming_output(output, newline):
    if config.pyversion[0] >= 3:
        if newline:
            print(output, file=config.stoutputf)
        else:
            print(output, end='', file=config.stoutputf)
    else:
        if newline:
            print(config.get_encode_str(output), file=config.stoutputf)
        else:
            print(config.get_encode_str(output), end='', file=config.stoutputf)


def _stata_wrk1(cmd, echo=False):
    if config.stconfig['streamout']=='on':
        try:
            queue = LifoQueue()
            callback = [] # catch errors of Stata thread
            outputter = stout.RepeatTimer('Stata', 1, queue, 0.015, None, None, None, callback)
            outputter.start()

            with stout.RedirectOutput(stout.StataDisplay(), stout.StataError()):
                rc1 = config.stlib.StataSO_Execute(config.get_encode_str(cmd), echo)

            queue.put(rc1)

            outputter.join()
            outputter.done()
            
            if len(callback) > 0:
                err = callback[0]
                callback.clear()
                raise SystemError(err)
        except KeyboardInterrupt:
            outputter.done()
            config.stlib.StataSO_SetBreak()
            print('\nKeyboardInterrupt: --break--')
    else:
        try:
            with stout.RedirectOutput(stout.StataDisplay(), stout.StataError()):
                rc1 = config.stlib.StataSO_Execute(config.get_encode_str(cmd), echo)

            output = config.get_output()
            while len(output)!=0:
                if rc1 != 0:
                    raise SystemError(output)

                _print_no_streaming_output(output, False)
                output = config.get_output()
            else:
                if rc1 != 0:
                    raise SystemError("failed to execute the specified command")
        except KeyboardInterrupt:
            config.stlib.StataSO_SetBreak()
            print('\nKeyboardInterrupt: --break--')


def _stata_wrk2(cmd, real_cmd, colon, mode, echo=True):
    global rc2
    if config.stconfig['streamout']=='on':
        try:
            queue = LifoQueue()
            callback = [] # catch errors of Stata thread
            outputter = stout.RepeatTimer('Stata', 2, queue, 0.015, real_cmd, colon, mode, callback)
            outputter.start()

            with stout.RedirectOutput(stout.StataDisplay(), stout.StataError(), echo):
                rc2 = config.stlib.StataSO_Execute(config.get_encode_str(cmd), False)
                
            queue.put(rc2)

            outputter.join()
            outputter.done()

            if len(callback) > 0:
                err = callback[0]
                callback.clear()
                raise SystemError(err)
        except KeyboardInterrupt:
            outputter.done()
            config.stlib.StataSO_SetBreak()
            print('\nKeyboardInterrupt: --break--')
    else:
        try:
            with stout.RedirectOutput(stout.StataDisplay(), stout.StataError(), echo):
                rc2 = config.stlib.StataSO_Execute(config.get_encode_str(cmd), False)

            output = config.get_output()
            if rc2 != 0:
                if rc2 != 3000:
                    if mode!=1:
                        output = stout.output_get_interactive_result(output, real_cmd, colon, mode)
                        _print_no_streaming_output(output, False)
                    else:
                        raise SystemError(config.get_encode_str(output))

            else:
                while len(output)!=0:
                    output_tmp = config.get_output()
                    if len(output_tmp)==0:
                        if mode!=1:
                            output = stout.output_get_interactive_result(output, real_cmd, colon, mode)
                            _print_no_streaming_output(output, False)
                        else:
                            _print_no_streaming_output(output, True)
                        break
                    else:
                        if mode!=1:
                            output = stout.output_get_interactive_result(output, real_cmd, colon, mode)
                            
                        _print_no_streaming_output(output, False)
                        output = output_tmp
        except KeyboardInterrupt:
            config.stlib.StataSO_SetBreak()
            print('\nKeyboardInterrupt: --break--')


def _get_user_input(uprompt):
    if config.pyversion[0]==2:
        return raw_input(uprompt)
    else:
        return input(uprompt)


def run(cmd, quietly=False, echo=None, inline=None):
    """
    Run a single line or a block of Stata commands. 

    If a single-line Stata command is specified, the command is run through 
    Stata directly. If you need to run a multiple-line command or a block of 
    Stata commands, enclose the commands within triple quotes, \""" or \'''. 
    The set of commands will be placed in a temporary do-file and executed all 
    at once. Because the commands are executed from a do-file, you can add comments 
    and delimiters with the specified commands.

    Parameters
    ----------
    cmd : str 
        The commands to execute. 

    quietly : bool, optional
        Suppress output from Stata commands. Default is False. When set to 
        True, output will be suppressed.

    echo : None, True, or False, optional
        Specify whether to echo the command(s). By default, when a single line of 
        Stata command is specified, only the ouput is displayed; when a block of 
        Stata commands is specified, each command and its output are displayed 
        in sequence. If `echo` is not specified or specified as 
        None, the global setting specified with 
        :meth:`~pystata.config.set_command_show` is applied.      

    inline : None, True, or False, optional
        Specify whether to export and display the graphs generated by the 
        commands, if there are any. If `inline` is not specified or specified as 
        None, the global setting specified with 
        :meth:`~pystata.config.set_graph_show` is applied.

    Raises
    ------
    SystemError
        This error can be raised if any of the specified Stata commands result 
        in an error.
    """
    global rc2
    config.check_initialized()

    if echo is not None:
        if echo is not True and echo is not False:
            raise TypeError('echo must be a boolean value')
            
    if inline is None:
        inline = config.stconfig['grshow']
    else:
        if inline is not True and inline is not False:
            raise TypeError('inline must be a boolean value')

    config.stlib.StataSO_ClearOutputBuffer()
    cmds = cmd.splitlines()
    if len(cmds) == 0:
        return 
    elif len(cmds) == 1:
        if inline:
            config.stlib.StataSO_Execute(config.get_encode_str("qui _gr_list on"), False)

        input_cmd = cmds[0].strip()
        if input_cmd=="mata" or input_cmd=="mata:":
            has_colon = False
            if input_cmd=="mata:":
                has_colon = True

            print('. ' + input_cmd)
            sfi.SFIToolkit.displayln("{hline 49} mata (type {cmd:end} to exit) {hline}")
            incmd = _get_user_input(": ").strip()
            incmds1 = ""
            incmds2 = "" 
            inprompt = ": "
            while incmd!="end":
                incmd = incmd + "\n"
                incmds1 = incmds1 + incmd
                incmd = inprompt + incmd
                incmds2 = incmds2 + incmd

                tmpf = sfi.SFIToolkit.getTempFile()
                with open(tmpf, 'w', encoding="utf-8") as f:
                    f.write(input_cmd+"\n")
                    f.write(incmds1)
                    f.write("end")

                if quietly:
                    _stata_wrk2("qui include " + tmpf, incmds2, has_colon, 2, True)
                else:
                    _stata_wrk2("include " + tmpf, incmds2, has_colon, 2, True)

                if rc2 != 0:
                    if rc2 != 3000:
                        break
                    else:
                        incmd = _get_user_input("> ").strip()
                        inprompt = "> "
                else:
                    incmd = _get_user_input(": ").strip()
                    incmds1 = ""
                    incmds2 = ""
                    inprompt = ": "
            else:
                sfi.SFIToolkit.displayln("{hline}")
        elif input_cmd=="python" or input_cmd=="python:":
            has_colon = False
            if input_cmd=="python:":
                has_colon = True

            print('. ' + input_cmd)
            sfi.SFIToolkit.displayln("{hline 47} python (type {cmd:end} to exit) {hline}")
            incmd = _get_user_input(">>> ")
            incmds1 = ""
            incmds2 = "" 
            inprompt = ">>> "
            while incmd!="end":
                incmds1 = incmds1 + incmd
                incmd = inprompt + incmd
                incmds2 = incmds2 + incmd

                if incmd[:6]!="stata:":
                    res = incmd
                    try:
                        res = codeop.compile_command(incmds1, '<input>', 'single')
                        incmds1 = incmds1 + "\n"
                        incmds2 = incmds2 + "\n"
                    except (OverflowError, SyntaxError, ValueError):
                        pass
                else: 
                    res = incmd
                   
                if res is None:
                    incmd = _get_user_input("... ")
                    inprompt = "... "
                else:
                    tmpf = sfi.SFIToolkit.getTempFile()
                    with open(tmpf, 'w', encoding="utf-8") as f:
                        f.write(input_cmd+"\n")
                        f.write(incmds1)
                        f.write("end")
					
                    if quietly:
                        _stata_wrk2("qui include " + tmpf, incmds2, has_colon, 3, True)
                    else:
                        _stata_wrk2("include " + tmpf, incmds2, has_colon, 3, True)

                    if rc2 != 0:
                        break

                    incmd = _get_user_input(">>> ")
                    incmds1 = ""
                    incmds2 = ""
                    inprompt = ">>> "						
            else:
                sfi.SFIToolkit.displayln("{hline}")
        else:
            if echo is None:
                echo = config.stconfig['cmdshow']
                if echo=='default': 
                    echo = False

            strip_cmd = cmds[0].strip()
            is_comment = False 
            if strip_cmd.startswith("//"):
                is_comment = True 
            elif strip_cmd.startswith("/*"):             
                if strip_cmd.endswith("/"): 
                    star_pos = strip_cmd.rfind('*')
                    if star_pos != -1:
                        if strip_cmd[star_pos:-1].strip() == "*":
                            is_comment = True     
                            
            if is_comment:
                if echo is True:
                    if quietly:
                        _print_no_streaming_output("", False)
                    else:
                        _print_no_streaming_output(". " + cmds[0], True)
                else:
                    _print_no_streaming_output("", False)
            else:
                if quietly:
                    _stata_wrk1("qui " + cmds[0], echo)
                else:
                    _stata_wrk1(cmds[0], echo)
    else:
        if echo is None:
            echo = config.stconfig['cmdshow']
            
        if inline:
            config.stlib.StataSO_Execute(config.get_encode_str("qui _gr_list on"), False)

        tmpf = sfi.SFIToolkit.getTempFile()
        with open(tmpf, 'w', encoding="utf-8") as f:
            f.write(cmd)

        if quietly:
            _stata_wrk2("qui include " + tmpf, None, False, 1, echo)
        else:
            _stata_wrk2("include " + tmpf, None, False, 1, echo)

    if inline:
        if config.get_stipython()>=3:
            global gr_display_func
            if gr_display_func is None:
                from pystata.ipython.grdisplay import display_stata_graph
                gr_display_func = display_stata_graph

            gr_display_func()

        config.stlib.StataSO_Execute(config.get_encode_str("qui _gr_list off"), False)


def nparray_to_data(arr, prefix='v', force=False):
    """
    Load a NumPy array into Stata's memory, making it the current dataset.

    When the data type of the array conforms to a Stata variable type, this 
    variable type will be used in Stata. Otherwise, each column of the array 
    will be converted into a string variable in Stata.

    By default, **v1**, **v2**, ... are used as the variable names in Stata. If 
    `prefix` is specified, it will be used as the variable prefix for all the 
    variables loaded into Stata.

    If there is a dataset in memory and it has been changed since it was last 
    saved, an attempt to load a NumPy array into Stata will raise an exception. 
    The `force` argument will force loading of the array, replacing the dataset 
    in memory.

    Parameters
    ----------
    arr : NumPy array
        The array to be loaded. 

    prefix : str, optional
        The string to be used as the variable prefix. Default is **v**. 

    force : bool, optional 
        Force loading of the array into Stata. Default is False. 

    Raises
    ------
    SystemError
        This error can be raised if there is a dataset in memory that has 
        changed since it was last saved, and `force` is False.
    """
    global has_num_pand
    config.check_initialized()

    if not has_num_pand['pknum']:
        raise SystemError('NumPy package is required to use this function.')

    changed = sfi.Scalar.getValue('c(changed)')
    if int(changed)==1 and force is False:
        raise SystemError('no; dataset in memory has changed since last saved')

    if int(changed)==0 or force is True:
        run('clear')

    numpy2stata.array_to_stata(arr, None, prefix)


def pdataframe_to_data(df, force=False):
    """
    Load a pandas DataFrame into Stata's memory, making it the current dataset.

    Each column of the DataFrame will be stored as a variable. If the column 
    type conforms to a Stata variable type, the variable type will be used in 
    Stata. Otherwise, the column will be converted into a string variable in 
    Stata. 

    The variable names will correspond to the column names of the DataFrame. If 
    the column name is a valid Stata name, it will be used as the variable 
    name. If it is not a valid Stata name, a valid variable name is created by 
    using the 
    `makeVarName() <https://www.stata.com/python/api18/SFIToolkit.html#sfi.SFIToolkit.makeVarName>`__ 
    method of the `SFIToolkit <https://www.stata.com/python/api18/SFIToolkit.html>`__ 
    class in the `Stata Function Interface (sfi) <https://www.stata.com/python/api18/>`__ module.

    If there is a dataset in memory and it has been changed since it was last 
    saved, an attempt to load a DataFrame into Stata will raise an exception. 
    The `force` argument will force loading of the DataFrame, replacing the 
    dataset in memory.

    Parameters
    ----------
    df : pandas DataFrame
        The DataFrame to be loaded.

    force : bool, optional 
        Force loading of the DataFrame into Stata. Default is False.

    Raises
    ------
    SystemError
        This error can be raised if there is a dataset in memory that has been 
        changed since it was last saved, and `force` is False.
    """
    global has_num_pand
    config.check_initialized()

    if not has_num_pand['pkpand']:
        raise SystemError('pandas package is required to use this function.')

    changed = sfi.Scalar.getValue('c(changed)')
    if int(changed)==1 and force is False:
        raise SystemError('no; dataset in memory has changed since last saved')

    if int(changed)==0 or force is True:
        run('clear')

    pandas2stata.dataframe_to_stata(df, None)


class _DefaultMissing:
    def __repr__(self):
        return "_DefaultMissing()"


def nparray_from_data(var=None, obs=None, selectvar=None, valuelabel=False, missingval=_DefaultMissing()):
    """
    Export values from the current Stata dataset into a NumPy array.

    Parameters
    ----------
    var : int, str, or list-like, optional
        Variables to access. It can be specified as a single variable
        index or name, or an iterable of variable indices or names. 
        If `var` is not specified, all the variables are specified.

    obs : int or list-like, optional
        Observations to access. It can be specified as a single 
        observation index or an iterable of observation indices. 
        If `obs` is not specified, all the observations are specified.

    selectvar : int or str, optional
        Observations for which `selectvar!=0` will be selected. If `selectvar`
        is an integer, it is interpreted as a variable index. If `selectvar` 
        is a string, it should contain the name of a Stata variable. 
        Specifying `selectvar` as "" has the same result as not 
        specifying `selectvar`, which means no observations are excluded. 
        Specifying `selectvar` as -1 means that observations with missing 
        values for the variables specified in `var` are to be excluded.

    valuelabel : bool, optional
        Use the value label when available. Default is False.

    missingval : :ref:`_DefaultMissing <ref-defaultmissing>`, `optional`
        If `missingval` is specified, all the missing values in the returned 
        list are replaced by this value. If it is not specified, the numeric 
        value of the corresponding missing value in Stata is returned.

    Returns
    -------
    NumPy array
        A NumPy array containing the values from the dataset in memory. 

    Raises
    ------
    ValueError
        This error can be raised for three possible reasons. One is if any of 
        the variable indices or names specified in `var` are out of 
        `range <https://www.stata.com/python/api18/Data.html#ref-datarange>`__ 
        or not found. Another is if any of the observation indices specified 
        in `obs` are out of range. Last, it may be raised if `selectvar` is out of 
        range or not found.


    .. _ref-defaultmissing:

    Notes
    -----
    The definition of the utility class **_DefaultMissing** is as follows::

        class _DefaultMissing:
            def __repr__(self):
                return "_DefaultMissing()"

    This class is defined only for the purpose of specifying the default 
    value for the parameter `missingval` of the above function. Users are 
    not recommended to use this class for any other purpose.
    """
    global has_num_pand
    config.check_initialized()

    if not has_num_pand['pknum']:
        raise SystemError('NumPy package is required to use this function.')

    if isinstance(missingval, _DefaultMissing):
        return numpy2stata.array_from_stata(None, var, obs, selectvar, valuelabel, None)
    else:
        return numpy2stata.array_from_stata(None, var, obs, selectvar, valuelabel, missingval)


def pdataframe_from_data(var=None, obs=None, selectvar=None, valuelabel=False, missingval=_DefaultMissing()):
    """
    Export values from the current Stata dataset into a pandas DataFrame.

    Parameters
    ----------
    var : int, str, or list-like, optional
        Variables to access. It can be specified as a single variable
        index or name, or an iterable of variable indices or names. 
        If `var` is not specified, all the variables are specified.

    obs : int or list-like, optional
        Observations to access. It can be specified as a single 
        observation index or an iterable of observation indices. 
        If `obs` is not specified, all the observations are specified.

    selectvar : int or str, optional
        Observations for which `selectvar!=0` will be selected. If `selectvar`
        is an integer, it is interpreted as a variable index. If `selectvar` 
        is a string, it should contain the name of a Stata variable. 
        Specifying `selectvar` as "" has the same result as not 
        specifying `selectvar`, which means no observations are excluded. 
        Specifying `selectvar` as -1 means that observations with missing 
        values for the variables specified in `var` are to be excluded.

    valuelabel : bool, optional
        Use the value label when available. Default is False.

    missingval : :ref:`_DefaultMissing <ref-defaultmissing>`, `optional`
        If `missingval` is specified, all the missing values in the returned 
        list are replaced by this value. If it is not specified, the numeric 
        value of the corresponding missing value in Stata is returned.

    Returns
    -------
    pandas DataFrame
        A pandas DataFrame containing the values from the dataset in memory.  

    Raises
    ------
    ValueError
        This error can be raised for three possible reasons. One is if any of 
        the variable indices or names specified in `var` are out of 
        `range <https://www.stata.com/python/api18/Data.html#ref-datarange>`__ 
        or not found. Another is if any of the observation indices specified 
        in `obs` are out of range. Last, it may be raised if `selectvar` is out of 
        range or not found.
    """
    global has_num_pand
    config.check_initialized()

    if not has_num_pand['pkpand']:
        raise SystemError('pandas package is required to use this function.')

    if isinstance(missingval, _DefaultMissing):
        return(pandas2stata.dataframe_from_stata(None, var, obs, selectvar, valuelabel, None))
    else:
        return(pandas2stata.dataframe_from_stata(None, var, obs, selectvar, valuelabel, missingval))


def nparray_to_frame(arr, stfr, prefix='v', force=False):
    """
    Load a NumPy array into a specified frame in Stata.

    When the data type of the array conforms to a Stata variable type, this 
    variable type will be used in the frame. Otherwise, each column of the 
    array will be converted into a string variable in the frame.

    By default, **v1**, **v2**, ... are used as the variable names in the frame. 
    If `prefix` is specified, it will be used as the variable prefix for all the 
    variables loaded into the frame.

    If the frame of the specified name already exists in Stata, an attempt to load 
    a NumPy array into the frame will raise an exception. The `force` argument will 
    force loading of the array, replacing the original frame.

    Parameters
    ----------
    arr : NumPy array
        The array to be loaded. 

    stfr : str 
        The frame in which to store the array. 

    prefix : str, optional
        The string to be used as the variable prefix. Default is **v**. 

    force : bool, optional 
        Force loading of the array into the frame if the frame already exists. 
        Default is False.

    Raises
    ------
    SystemError
        This error can be raised if the specified frame already exists in 
        Stata, and `force` is False.
    """
    global has_num_pand
    config.check_initialized()

    if not has_num_pand['pknum']:
        raise SystemError('NumPy package is required to use this function.')

    stframe = None
    try:
	    stframe = sfi.Frame.connect(stfr)
    except:
        pass

    if stframe is not None:
        if force is False:
            raise SystemError('%s already exists.' % stfr)

        stframe.drop()

    numpy2stata.array_to_stata(arr, stfr, prefix)


def pdataframe_to_frame(df, stfr, force=False):
    """
    Load a pandas DataFrame into a specified frame in Stata.  

    Each column of the DataFrame will be stored as a variable in the frame. 
    If the column type conforms to a Stata variable type, the variable type 
    will be used in the frame. Otherwise, the column will be converted into a 
    string variable in the frame.

    The variable names will correspond to the column names of the DataFrame. 
    If the column name is a valid Stata name, it will be used as the 
    variable name. If it is not a valid Stata name, a valid variable name is 
    created by using 
    the `makeVarName() <https://www.stata.com/python/api18/SFIToolkit.html#sfi.SFIToolkit.makeVarName>`__ 
    method of the `SFIToolkit <https://www.stata.com/python/api18/SFIToolkit.html>`__ 
    class in the `Stata Function Interface (sfi) <https://www.stata.com/python/api18/>`__ module.

    If the frame of the specified name already exists in Stata, an attempt to 
    load a pandas DataFrame into the frame will raise an exception. The `force` 
    argument will force loading of the DataFrame, replacing the original frame.

    Parameters
    ----------
    df : pandas DataFrame
        The DataFrame to be loaded. 

    stfr : str 
        The frame in which to store the DataFrame. 

    force : bool, optional 
        Force loading of the DataFrame into the frame if the frame already 
        exists. Default is False.

    Raises
    ------
    SystemError
        This error can be raised if the specified frame already exists 
        in Stata, and `force` is False.
    """
    global has_num_pand
    config.check_initialized()

    if not has_num_pand['pkpand']:
        raise SystemError('pandas package is required to use this function.')

    stframe = None
    try:
	    stframe = sfi.Frame.connect(stfr)
    except:
        pass

    if stframe is not None:
        if force is False:
            raise SystemError('%s already exists.' % stfr)

        stframe.drop()

    pandas2stata.dataframe_to_stata(df, stfr)


def nparray_from_frame(stfr, var=None, obs=None, selectvar=None, valuelabel=False, missingval=_DefaultMissing()):
    """
    Export values from a Stata frame into a NumPy array.

    Parameters
    ----------
    stfr : str
        The Stata frame to export. 

    var : int, str, or list-like, optional
        Variables to access. It can be specified as a single variable
        index or name, or an iterable of variable indices or names. 
        If `var` is not specified, all the variables are specified.

    obs : int or list-like, optional
        Observations to access. It can be specified as a single 
        observation index or an iterable of observation indices. 
        If `obs` is not specified, all the observations are specified.

    selectvar : int or str, optional
        Observations for which `selectvar!=0` will be selected. If `selectvar`
        is an integer, it is interpreted as a variable index. If `selectvar` 
        is a string, it should contain the name of a Stata variable. 
        Specifying `selectvar` as "" has the same result as not 
        specifying `selectvar`, which means no observations are excluded. 
        Specifying `selectvar` as -1 means that observations with missing 
        values for the variables specified in `var` are to be excluded.

    valuelabel : bool, optional
        Use the value label when available. Default is False.

    missingval : :ref:`_DefaultMissing <ref-defaultmissing>`, `optional`
        If `missingval` is specified, all the missing values in the returned 
        list are replaced by this value. If it is not specified, the numeric 
        value of the corresponding missing value in Stata is returned.

    Returns
    -------
    NumPy array
        A NumPy array containing the values from the Stata frame. 

    Raises
    ------
    ValueError
        This error can be raised for three possible reasons. One is if any 
        of the variable indices or names specified in `var` are out of 
        `range <https://www.stata.com/python/api18/Frame.html#ref-framerange>`__ 
        or not found. Another is if any of the observation indices specified 
        in `obs` are out of range. Last, it may be raised if `selectvar` is out of 
        range or not found.

    FrameError
        This `error <https://www.stata.com/python/api18/FrameError.html#sfi.FrameError>`__ 
        can be raised if the frame `stfr` does not already exist in Stata, or 
        if Python fails to connect to the frame.
    """
    global has_num_pand
    config.check_initialized()

    if not has_num_pand['pknum']:
        raise SystemError('NumPy package is required to use this function.')

    if isinstance(missingval, _DefaultMissing):
        return numpy2stata.array_from_stata(stfr, var, obs, selectvar, valuelabel, None)
    else:
        return numpy2stata.array_from_stata(stfr, var, obs, selectvar, valuelabel, missingval)


def pdataframe_from_frame(stfr, var=None, obs=None, selectvar=None, valuelabel=False, missingval=_DefaultMissing()):
    """
    Export values from a Stata frame into a pandas DataFrame.

    Parameters
    ----------
    stfr : str
        The Stata frame to export. 

    var : int, str, or list-like, optional
        Variables to access. It can be specified as a single variable
        index or name, or an iterable of variable indices or names. 
        If `var` is not specified, all the variables are specified.

    obs : int or list-like, optional
        Observations to access. It can be specified as a single 
        observation index or an iterable of observation indices. 
        If `obs` is not specified, all the observations are specified.

    selectvar : int or str, optional
        Observations for which `selectvar!=0` will be selected. If `selectvar`
        is an integer, it is interpreted as a variable index. If `selectvar` 
        is a string, it should contain the name of a Stata variable. 
        Specifying `selectvar` as "" has the same result as not 
        specifying `selectvar`, which means no observations are excluded. 
        Specifying `selectvar` as -1 means that observations with missing 
        values for the variables specified in `var` are to be excluded.

    valuelabel : bool, optional
        Use the value label when available. Default is False.

    missingval : :ref:`_DefaultMissing <ref-defaultmissing>`, `optional`
        If `missingval` is specified, all the missing values in the returned 
        list are replaced by this value. If it is not specified, the numeric 
        value of the corresponding missing value in Stata is returned.

    Returns
    -------
    pandas DataFrame
        A pandas DataFrame containing the values from the Stata frame. 

    Raises
    ------
    ValueError
        This error can be raised for three possible reasons. One is if any of 
        the variable indices or names specified in `var` are out of 
        `range <https://www.stata.com/python/api18/Frame.html#ref-framerange>`__ 
        or not found. Another is if any of the observation indices specified 
        in `obs` are out of range. Last, it may be raised if `selectvar` is out of 
        range or not found.

    FrameError
        This `error <https://www.stata.com/python/api18/FrameError.html#sfi.FrameError>`__  
        can be raised if the frame `stfr` does not already exist in Stata, 
        or if Python fails to connect to the frame.
    """
    global has_num_pand
    config.check_initialized()

    if not has_num_pand['pkpand']:
        raise SystemError('pandas package is required to use this function.')

    if isinstance(missingval, _DefaultMissing):
        return(pandas2stata.dataframe_from_stata(stfr, var, obs, selectvar, valuelabel, None))
    else:
        return(pandas2stata.dataframe_from_stata(stfr, var, obs, selectvar, valuelabel, missingval))


def _get_return_val(res, cat):
    if cat=="r()":
        rrscalar = sfi.SFIToolkit.listReturn("r()", "scalar")
        rscalar = rrscalar.split()
        for rs in rscalar:
            rs = "r(" + rs + ")"
            val = sfi.Scalar.getValue(rs)
            res[rs] = val

        rrmac = sfi.SFIToolkit.listReturn("r()", "macro")
        rmac = rrmac.split()
        for rs in rmac:
            rs = "r(" + rs + ")"
            val = sfi.Macro.getGlobal(rs)
            res[rs] = val

        rrmat = sfi.SFIToolkit.listReturn("r()", "matrix")
        rmat = rrmat.split()
        for rm in rmat:
            rm = "r(" + rm + ")"
            val = numpy2stata.array_from_matrix(sfi.Matrix.get(rm))
            res[rm] = val

    elif cat=="e()":
        eenum = sfi.SFIToolkit.listReturn("e()", "scalar")
        enum = eenum.split()
        for en in enum:
            en = "e(" + en + ")"
            val = sfi.Scalar.getValue(en)
            res[en] = val

        eestr = sfi.SFIToolkit.listReturn("e()", "macro")
        estr = eestr.split()
        for es in estr:
            es = "e(" + es + ")"
            val = sfi.Macro.getGlobal(es)
            res[es] = val

        eemat = sfi.SFIToolkit.listReturn("e()", "matrix")
        emat = eemat.split()
        for em in emat:
            em = "e(" + em + ")"
            val = numpy2stata.array_from_matrix(sfi.Matrix.get(em))
            res[em] = val

    else:
        ssmac = sfi.SFIToolkit.listReturn("s()", "macro")
        smac = ssmac.split()
        for ss in smac:
            ss = "s(" + ss + ")"
            val = sfi.Macro.getGlobal(ss)
            res[ss] = val

    return res

	
def get_return():
    """
    Retrieve current **r()** results and store them in a Python dictionary.

    The keys are Stata's macro and scalar names, and the values are their 
    corresponding values. Stata's matrices are converted into NumPy arrays. 

    Returns
    -------
    Dictionary
        A dictionary containing current **r()** results. 
    """
    global has_num_pand
    config.check_initialized()

    if not has_num_pand['pknum']:
        raise SystemError('NumPy package is required to use this function.')

    res = {}
    _get_return_val(res, "r()")
    return res


def get_ereturn():
    """
    Retrieve current **e()** results and store them in a Python dictionary.

    The keys are Stata's macro and scalar names, and the values are their 
    corresponding values. Stata's matrices are converted into NumPy arrays. 

    Returns
    -------
    Dictionary
        A dictionary containing current **e()** results. 
    """
    global has_num_pand
    config.check_initialized()

    if not has_num_pand['pknum']:
        raise SystemError('NumPy package is required to use this function.')

    res = {}
    _get_return_val(res, "e()")
    return res


def get_sreturn():
    """
    Retrieve current **s()** results and store them in a Python dictionary.

    The keys are Stata's macro and scalar names, and the values are their 
    corresponding values. Stata's matrices are converted into NumPy arrays. 

    Returns
    -------
    Dictionary
        A dictionary containing current **s()** results. 
    """
    global has_num_pand
    config.check_initialized()

    if not has_num_pand['pknum']:
        raise SystemError('NumPy package is required to use this function.')
	
    res = {}
    _get_return_val(res, "s()")
    return res
