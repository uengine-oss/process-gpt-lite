# The meeting-minutes template of the 2026-11-25 12:57 production report (회의록_템플릿.docx), the way an agent writes it with
# python-docx and its default template: a title, a 3×4 label table (row 3: 참석자 + one value cell over three columns, labels
# shaded), a heading, a 4-column table. No row heights: every cell paragraph carries the default space after (w:pPrDefault,
# 200 twips) and the rows are as tall as a line plus that space — the labels sit at the top of their cells.
#   python3 meeting-minutes-labels.py            → meeting-minutes-labels.docx, meeting-minutes-labels-gap.docx
# The -gap copy has an empty paragraph under each label (a label cell whose text cannot be centred by its alignment alone).
import os
from docx import Document
from docx.shared import Pt
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

here = os.path.dirname(os.path.abspath(__file__))


def shade(cell, fill):
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear'); shd.set(qn('w:color'), 'auto'); shd.set(qn('w:fill'), fill)
    cell._tc.get_or_add_tcPr().append(shd)


def borders(table, color='D0D5DD'):
    b = OxmlElement('w:tblBorders')
    for side in ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']:
        e = OxmlElement(f'w:{side}')
        e.set(qn('w:val'), 'single'); e.set(qn('w:sz'), '4'); e.set(qn('w:space'), '0'); e.set(qn('w:color'), color)
        b.append(e)
    table._tbl.tblPr.append(b)


def make(name, gap):
    d = Document()
    title = d.add_paragraph(); title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = title.add_run('회의록'); run.bold = True; run.font.size = Pt(20)
    t = d.add_table(rows=3, cols=4)
    borders(t)
    for (r, c), text in {(0, 0): '회의명', (0, 2): '일시', (1, 0): '장소/방식', (1, 2): '작성자', (2, 0): '참석자'}.items():
        cell = t.cell(r, c)
        cell.text = text
        cell.paragraphs[0].runs[0].bold = True
        shade(cell, 'F2F4F7')
        if gap: cell.add_paragraph('')
    t.cell(2, 1).merge(t.cell(2, 3))
    d.add_heading('1. 회의 목적 및 안건', level=2)
    d.add_paragraph('회의 목적: ________________________________')
    d.add_heading('2. 논의 내용', level=2)
    t2 = d.add_table(rows=4, cols=4)
    borders(t2)
    for c, text in enumerate(['순번', '논의 주제', '주요 내용']):
        cell = t2.cell(0, c); cell.text = text; cell.paragraphs[0].runs[0].bold = True; shade(cell, 'F2F4F7')
    for r in range(1, 4): t2.cell(r, 0).text = str(r)
    d.save(os.path.join(here, name))


make('meeting-minutes-labels.docx', False)
make('meeting-minutes-labels-gap.docx', True)
