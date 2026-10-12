from IPython import version_info as ipy_version
if ipy_version[0] < 4:
    from IPython.utils.path import get_ipython_cache_dir
else:
    from IPython.paths import get_ipython_cache_dir

def get_ipython_stata_cache_dir():
    return get_ipython_cache_dir()
