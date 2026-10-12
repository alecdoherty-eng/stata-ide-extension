from pystata.config import stlib, stconfig, get_encode_str
from IPython.display import SVG, display, Image
from pystata.ipython.ipy_utils import get_ipython_stata_cache_dir
import sfi
import os

pdf_counter = 0

def _get_graphs_info():
    stlib.StataSO_Execute(get_encode_str("qui _gr_list list"), False)
    gnamelist = sfi.Macro.getGlobal("r(_grlist)")

    graphs_info = []
    for gname in gnamelist.split():
        graphs_info.append(gname)

    return graphs_info


class _Pdf_Display_Obj:
    def __init__(self, pdf, width, height):
        self.pdf = pdf
        self.width = width
        self.height = height

    def _repr_html_(self):
        return '<iframe src={0} width={1} height={2} frameBorder="0"></iframe>'.format(self.pdf, self.width, self.height)

    def _repr_latex_(self):
        return r'\includegraphics[width=1.0\textwidth,keepaspectratio]{{{0}}}'.format(self.pdf)

    def __repr__(self):
        return '(file ' + self.pdf + ' written in PDF format)'


def display_stata_graph():
    global pdf_counter

    grformat = stconfig['grformat']
    grwidth = stconfig['grwidth']
    grheight = stconfig['grheight']
    if grformat=="svg":
        if grwidth[0]=='default':
            gwidth_str = ""
        else:
            if grwidth[1]=='cm':
                gwidth_str = str(round(grwidth[0]/2.54, 3)) + 'in'
            else:
                gwidth_str = str(grwidth[0]) + grwidth[1]

        if grheight[0]=='default':
            gheight_str = ""
        else:
            if grheight[1]=='cm':
                gheight_str = str(round(grheight[0]/2.54, 3)) + 'in'
            else:	    
                gheight_str = str(grheight[0]) + grheight[1]
    elif grformat=="png":
        if grwidth[0]=='default':
            gwidth_str = ""
        else:	    
            if grwidth[1]=='px':
                gwidth_str = str(grwidth[0])
            elif grwidth[1]=='cm':
                gwidth_str = str(int(round(grwidth[0]*96/2.54)))
            else:
                gwidth_str = str(int(round(grwidth[0]*96)))

        if grheight[0]=='default':
            gheight_str = ""
        else:
            if grheight[1]=='px':
                gheight_str = str(grheight[0])
            elif grheight[1]=='cm':
                gheight_str = str(int(round(grheight[0]*96/2.54)))
            else:
                gheight_str = str(int(round(grheight[0]*96)))
    else:
        gwidth = -1
        gheight = -1
        if grwidth[0]=='default':
            gwidth_str = ""
        else:	 
            if grwidth[1]=='px':
                gwidth_str = str(grwidth[0]*1.0/96)
                gwidth = grwidth[0]
            elif grwidth[1]=='cm':
                gwidth_str = str(grwidth[0]*1.0/2.54)
                gwidth = grwidth[0]*96/2.54               
            else:
                gwidth_str = str(grwidth[0])
                gwidth = grwidth[0]*96

        if grheight[0]=='default':
            gheight_str = ""
        else:
            if grheight[1]=='px':
                gheight_str = str(grheight[0]*1.0/96)
                gheight = grheight[0]
            elif grheight[1]=='cm':
                gheight_str = str(grheight[0]*1.0/2.54)
                gheight = grheight[0]*96/2.54
            else:
                gheight_str = str(grheight[0])
                gheight = grheight[0]*96

        if gwidth==-1 and gheight==-1:
            gwidth = 720
            gheight = 432
        elif gwidth==-1:
            gwidth = gheight*720.0/432
        elif gheight==-1:
            gheight = gwidth*432.0/720

    graphs_info = _get_graphs_info()
    gdir = get_ipython_stata_cache_dir()
    glen = len(graphs_info)
    if glen > 0:
        for i in range(glen):
            gph_disp = 'qui graph display %s' % graphs_info[i]
            rc = stlib.StataSO_Execute(get_encode_str(gph_disp), False)
            if rc!=0:
                continue

            if grformat=='svg':
                graph_out = os.path.join(gdir, 'temp_graph'+str(i)+'.svg')
                if gwidth_str!="" and gheight_str!="":
                    gph_exp = 'qui graph export "%s", name(%s) replace width(%s) height(%s) ' % (graph_out, graphs_info[i], gwidth_str, gheight_str)		
                elif gwidth_str!="":
                    gph_exp = 'qui graph export "%s", name(%s) replace width(%s) ' % (graph_out, graphs_info[i], gwidth_str)		
                elif gheight_str!="":
                    gph_exp = 'qui graph export "%s", name(%s) replace height(%s) ' % (graph_out, graphs_info[i], gheight_str)
                else:
                    gph_exp = 'qui graph export "%s", name(%s) replace' % (graph_out, graphs_info[i])

                stlib.StataSO_Execute(get_encode_str(gph_exp), False)
                display(SVG(filename=graph_out))
            elif grformat=='png':
                graph_out = os.path.join(gdir, 'temp_graph'+str(i)+'.png')
                if gwidth_str!="" and gheight_str!="":
                    gph_exp = 'qui graph export "%s", name(%s) replace width(%s) height(%s) ' % (graph_out, graphs_info[i], gwidth_str, gheight_str)
                elif gwidth_str!="":
                    gph_exp = 'qui graph export "%s", name(%s) replace width(%s) ' % (graph_out, graphs_info[i], gwidth_str)
                elif gheight_str!="":
                    gph_exp = 'qui graph export "%s", name(%s) replace height(%s) ' % (graph_out, graphs_info[i], gheight_str)
                else:
                    gph_exp = 'qui graph export "%s", name(%s) replace ' % (graph_out, graphs_info[i])

                stlib.StataSO_Execute(get_encode_str(gph_exp), False)
                display(Image(filename=graph_out))
            else:
                graph_out = os.path.join(os.getcwd(), str(pdf_counter)+'.pdf')
                if gwidth_str!="" and gheight_str!="":
                    gph_exp = 'qui graph export "%s", name(%s) replace xsize(%s) ysize(%s) ' % (graph_out, graphs_info[i], gwidth_str, gheight_str)
                elif gwidth_str!="":
                    gph_exp = 'qui graph export "%s", name(%s) replace xsize(%s) ' % (graph_out, graphs_info[i], gwidth_str)
                elif gheight_str!="":
                    gph_exp = 'qui graph export "%s", name(%s) replace ysize(%s) ' % (graph_out, graphs_info[i], gheight_str)
                else:
                    gph_exp = 'qui graph export "%s", name(%s) replace ' % (graph_out, graphs_info[i])

                stlib.StataSO_Execute(get_encode_str(gph_exp), False)
                display(_Pdf_Display_Obj(os.path.relpath(graph_out), int(gwidth*1.1), int(gheight*1.1)))
                pdf_counter += 1
