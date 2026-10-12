import sfi
import numpy as np

def array_from_mata(mat):
    return np.array(sfi.Mata.get(mat))


def array_to_mata(arr, mat):
    if not isinstance(arr, np.ndarray):
        raise TypeError("An NumPy array is required.")

    ndim = len(arr.shape)
    if ndim < 1 or ndim >= 3:
        raise TypeError("Dimension of array must not be greater than 2.")

    nobs = len(arr)
    if nobs == 0:
        return None

    dtype = arr.dtype.name
    if dtype in ['bool_', 'bool8', 'byte']:
        dtypestr = 'real'
    elif dtype in ['short', 'intc', 'int8', 'int16', 'int32', 'ubyte', 'ushort', 'uintc', 'uint8', 'uint16']:
        dtypestr = 'real'
    elif dtype in ['int_', 'longlong', 'intp', 'int64', 'uint', 'ulonglong', 'uint32', 'uint64']:
        dtypestr = 'real'
    elif dtype in ['half', 'single', 'float16', 'float32']:
        dtypestr = 'real'
    elif dtype in ['double', 'float_', 'longfloat', 'float64', 'float96', 'float128']:
        dtypestr = 'real'
    elif dtype in ['csingle', 'cdouble', 'clongdouble', 'complex64', 'complex128', 'complex_']:
        dtypestr = 'complex'
    else:
        dtypestr = 'string'

    if ndim == 1:
        if dtypestr=='real':
            sfi.Mata.create(mat, 1, arr.shape[0], sfi.Missing.getValue())
        elif dtypestr=='complex':
            sfi.Mata.create(mat, 1, arr.shape[0], 0j)
        else:
            sfi.Mata.create(mat, 1, arr.shape[0], '')

        sfi.Mata.store(mat, arr)
    else:
        if dtypestr=='real':
            sfi.Mata.create(mat, arr.shape[0], arr.shape[1], sfi.Missing.getValue())
        elif dtypestr=='complex':
            sfi.Mata.create(mat, arr.shape[0], arr.shape[1], 0j)
        else:
            sfi.Mata.create(mat, arr.shape[0], arr.shape[1], '')

        sfi.Mata.store(mat, arr)
