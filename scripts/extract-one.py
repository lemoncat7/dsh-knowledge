"""One-document extractor. stdin JSON -> stdout JSON; only the requested dst is written."""
import sys, json, pathlib, traceback

def extract(src):
    ext = src.suffix.lower()
    if ext in ('.txt', '.md', '.csv'):
        data = src.read_bytes()
        for enc in ('utf-8-sig', 'utf-16', 'gb18030'):
            try: return data.decode(enc), 'text'
            except UnicodeError: pass
        raise ValueError('Unsupported text encoding')
    if ext == '.pdf':
        from pypdf import PdfReader
        return '\n\n'.join(p.extract_text() or '' for p in PdfReader(src).pages), 'pypdf'
    if ext == '.docx':
        from docx import Document
        doc = Document(src)
        sections = [p.text for p in doc.paragraphs]
        sections.extend('\n'.join(' | '.join(c.text for c in r.cells) for r in t.rows) for t in doc.tables)
        return '\n\n'.join(sections), 'python-docx'
    if ext == '.pptx':
        from pptx import Presentation
        return '\n\n'.join('\n'.join(s.text for s in slide.shapes if s.has_text_frame) for slide in Presentation(src).slides), 'python-pptx'
    if ext == '.xlsx':
        import openpyxl
        wb = openpyxl.load_workbook(src, read_only=True, data_only=True)
        try: return '\n\n'.join('# '+sheet.title+'\n'+'\n'.join(' | '.join('' if v is None else str(v) for v in row) for row in sheet.iter_rows(values_only=True)) for sheet in wb), 'openpyxl'
        finally: wb.close()
    if ext == '.xls':
        import xlrd
        wb = xlrd.open_workbook(str(src))
        return '\n\n'.join('# '+s.name+'\n'+'\n'.join(' | '.join(str(v) for v in s.row_values(r)) for r in range(s.nrows)) for s in wb.sheets()), 'xlrd'
    return '', 'register-only'

def main():
    # Windows pipes default to the ANSI code page; JSON is UTF-8 on both ends.
    request = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    src = pathlib.Path(request['src']).resolve(strict=True)
    if not src.is_file() or src.stat().st_size > 256*1024*1024:
        raise ValueError('File is not regular or exceeds 256 MiB')
    text, parser = extract(src)
    if len(text) > 4000000: raise ValueError('Extracted text exceeds 4 million characters')
    quality = 'none' if parser == 'register-only' or not text.strip() else 'full' if len(text.strip()) >= 20 else 'partial'
    result = dict(quality=quality, chars=len(text), parser=parser, error=None)
    if request.get('preview'):
        result['preview'] = text[:2000]
    else:
        dst = pathlib.Path(request['dst'])
        with dst.open('x', encoding='utf-8', newline='\n') as out:
            out.write(text)
    return result

try:
    result = main()
except Exception as exc:
    result = dict(quality='failed', chars=0, error=type(exc).__name__+': '+str(exc))
sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode('utf-8') + b'\n')
sys.stdout.buffer.flush()
