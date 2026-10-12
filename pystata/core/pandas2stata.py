import sfi
import pandas as pd

def _make_indexed_name(index, stnames, pdnames):
    count = 0
    varn = "v" + str(index+count)
    while True:
        if varn in stnames or varn in pdnames:
            count = count + 1
            varn = "v" + str(index+count)
        else:
            break

    return varn 


def _make_varname(s, index, stnames, pdnames):
    s = str(s)
    if sfi.SFIToolkit.isValidVariableName(s):
        stnames.append(s)
        return(s)
    else:
        try:
            varn = sfi.SFIToolkit.makeVarName(s, True)
            if varn in stnames or varn in pdnames:
                varn = _make_indexed_name(index, stnames, pdnames)
        except:
            varn = _make_indexed_name(index, stnames, pdnames)

        stnames.append(varn)	
        return varn


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


def dataframe_to_stata(df, stfr):
    if not isinstance(df, pd.DataFrame):
        raise TypeError("A Pandas dataframe is required.")

    nobs = len(df)
    if nobs == 0:
        return None

    colnames = list(df.columns)
    stnames = []

    if stfr is None:
        sfi.Data.setObsTotal(nobs)
        var = 0
        for col in colnames:
            vtype = df.dtypes[col].name.lower()
            dta = df[col]
            col = _make_varname(col, var+1, stnames, colnames)
            if vtype=="int_" or vtype=="int8" or vtype=="int16" or vtype=="int32" or \
                vtype=="uint8" or vtype=="uint16":
                _add_var(col, "int")
                sfi.Data.store(var, None, dta)
            elif vtype=="int64" or vtype=='uint32':
                _add_var(col, "long")
                sfi.Data.store(var, None, dta)
            elif vtype=="float_" or vtype=="float16" or vtype=="float32":
                _add_var(col, "float")
                sfi.Data.store(var, None, dta)
            elif vtype=="float64":
                _add_var(col, "double")
                sfi.Data.store(var, None, dta)
            elif vtype=="bool":
                _add_var(col, "byte")
                sfi.Data.store(var, None, dta)
            else:
                _add_var(col, "str")
                m = dta.isnull() | dta.isna()
                dta = dta.astype(str).mask(m, "")
                sfi.Data.store(var, None, dta)

            var = var + 1
    else:
        fr = sfi.Frame.create(stfr)
        fr.setObsTotal(nobs)
        var = 0
        for col in colnames:
            vtype = df.dtypes[col].name.lower()
            dta = df[col]
            col = _make_varname(col, var+1, stnames, colnames)
            if vtype=="int_" or vtype=="int8" or vtype=="int16" or vtype=="int32" or \
                vtype=="uint8" or vtype=="uint16":
                _add_var(col, "int", fr)
                fr.store(var, None, dta)
            elif vtype=="int64" or vtype=='uint32':
                _add_var(col, "long", fr)
                fr.store(var, None, dta)
            elif vtype=="float_" or vtype=="float16" or vtype=="float32":
                _add_var(col, "float", fr)
                fr.store(var, None, dta)
            elif vtype=="float64":
                _add_var(col, "double", fr)
                fr.store(var, None, dta)
            elif vtype=="bool":
                _add_var(col, "byte", fr)
                fr.store(var, None, dta)
            else:
                _add_var(col, "str", fr)
                m = dta.isnull() | dta.isna()
                dta = dta.astype(str).mask(m, "")
                fr.store(var, None, dta)

            var = var + 1


def dataframe_from_stata(stfr, var, obs, selectvar, valuelabel, missingval):
    if stfr is None:
        nobs = sfi.Data.getObsTotal()
        if nobs <= 0:
            return None

        if missingval is None:
            df = pd.DataFrame(sfi.Data.getAsDict(var, obs, selectvar, valuelabel))
        else:
            df = pd.DataFrame(sfi.Data.getAsDict(var, obs, selectvar, valuelabel, missingval))

        return(df)
    else:
        fr = sfi.Frame.connect(stfr)
        nobs = fr.getObsTotal()
        if nobs <= 0:
            return None

        if missingval is None:
            df = pd.DataFrame(fr.getAsDict(var, obs, selectvar, valuelabel))
        else:
            df = pd.DataFrame(fr.getAsDict(var, obs, selectvar, valuelabel, missingval))

        return(df)
