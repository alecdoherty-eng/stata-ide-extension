class PyStataError(Exception):
    """
    This class is the base class for other exceptions defined in this module.
    """
    pass


class IPythonError(PyStataError):
    """
    The class is used to indicate whether the system has IPython support.
    """
    pass

class IPyKernelError(PyStataError):
    """
    The class is used to indicate whether pystata is running in IPython 
    interactive session.
    """
    pass
