import sfi
import numpy as np

def _get_varname(arr):
    return [str(e) for e in arr]


def _add_var(name, type, stfr=None):
    if stfr is None:
        if type=="byte":
            sfi.Data.addVarByte(name)
        elif type=="int":
            sfi.Data.addVarInt(name)
        elif type=="long":
            sfi.Data.addVarLong(name)
        elif type=="float":
            sfi.Data.addVarFloat(name)
        elif type=="double":
            sfi.Data.addVarDouble(name)
        else:
            sfi.Data.addVarStr(name, 9)
    else:
        if type=="byte":
            stfr.addVarByte(name)
        elif type=="int":
            stfr.addVarInt(name)
        elif type=="long":
            stfr.addVarLong(name)
        elif type=="float":
            stfr.addVarFloat(name)
        elif type=="double":
            stfr.addVarDouble(name)
        else:
            stfr.addVarStr(name, 9)


def array_to_stata(arr, stfr, prefix):
    if not isinstance(arr, np.ndarray):
        raise TypeError("An NumPy array is required.")

    ndim = len(arr.shape)
    if ndim < 1 or ndim >= 3:
        raise TypeError("Dimension of array must not be greater than 2.")

    nobs = len(arr)
    if nobs == 0:
        return None

    vtype = arr.dtype.name
    if vtype in ['bool_', 'bool8', 'byte']:
        vtypestr = 'byte'
    elif vtype in ['short', 'intc', 'int8', 'int16', 'int32', 'ubyte', 'ushort', 'uintc', 'uint8', 'uint16']:
        vtypestr = 'int'
    elif vtype in ['int_', 'longlong', 'intp', 'int64', 'uint', 'ulonglong', 'uint32', 'uint64']:
        vtypestr = 'long'
    elif vtype in ['half', 'single', 'float16', 'float32']:
        vtypestr = 'float'
    elif vtype in ['double', 'float_', 'longfloat', 'float64', 'float96', 'float128']:
        vtypestr = 'double'
    else:
        vtypestr = 'str'

    if stfr is None:
        sfi.Data.setObsTotal(nobs)
        if ndim == 1:
            _add_var(prefix+"1", vtypestr)
            sfi.Data.store(0, None, arr)	
        else:
            ncol = arr.shape[1]
            for col in range(ncol):
                _add_var(prefix+str(col+1), vtypestr)
                dta = arr[:,col]
                sfi.Data.store(col, None, dta)
    else:
        fr = sfi.Frame.create(stfr)
        fr.setObsTotal(nobs)

        if ndim == 1:
            _add_var(prefix+"1", vtypestr, fr)
            fr.store(0, None, arr)	
        else:
            ncol = arr.shape[1]
            for col in range(ncol):
                _add_var(prefix+str(col+1), vtypestr, fr)
                dta = arr[:,col]
                fr.store(col, None, dta)


def array_from_stata(stfr, var, obs, selectvar, valuelabel, missingval):
    if stfr is None:
        nobs = sfi.Data.getObsTotal()
        if nobs <= 0:
            return None

        if missingval is None:
            return(np.array(sfi.Data.get(var, obs, selectvar, valuelabel)))
        else:
            return(np.array(sfi.Data.get(var, obs, selectvar, valuelabel, missingval)))
    else:
        fr = sfi.Frame.connect(stfr)
        nobs = fr.getObsTotal()
        if nobs <= 0:
            return None

        if missingval is None:
            return(np.array(fr.get(var, obs, selectvar, valuelabel)))
        else:
            return(np.array(fr.get(var, obs, selectvar, valuelabel, missingval)))


def array_from_matrix(stmat):
    return np.array(stmat)
