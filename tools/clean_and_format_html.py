import re, shutil, sys, subprocess
from pathlib import Path
p=Path('krishna_portfolio.html')
if not p.exists():
    p=Path(r'C:\Users\13099\Desktop\Krishna\Krishna\krishna_portfolio.html')
    if not p.exists():
        print('file not found'); sys.exit(1)
# backup
bak=p.with_suffix('.html.bak')
shutil.copy2(p,bak)
print('Backup created at',bak)
text = p.read_text(encoding='utf-8')
# extract first <style> block
m=re.search(r'(<style[^>]*>)([\s\S]*?)(</style>)', text, flags=re.I)
if not m:
    print('No <style> block found')
    sys.exit(0)
open_tag, css_block, close_tag = m.group(1), m.group(2), m.group(3)
# split into rule blocks by '}'
raw_rules = []
cur=''
for ch in css_block:
    cur += ch
    if ch == '}':
        raw_rules.append(cur)
        cur=''
if cur.strip():
    raw_rules.append(cur)
print(f'Found {len(raw_rules)} CSS blocks')
# determine usage
html_body = text
kept_rules=[]
removed=0
for rule in raw_rules:
    parts = rule.split('{',1)
    if len(parts)<2:
        kept_rules.append(rule); continue
    selector = parts[0]
    class_names = re.findall(r'\.([A-Za-z0-9_-]+)', selector)
    if not class_names:
        kept_rules.append(rule); continue
    used=False
    for cname in class_names:
        # look for class="... cname ..." or class='...'
        if re.search(r'class\s*=\s*"[^"]*\b'+re.escape(cname)+r'\b[^"]*"', html_body):
            used=True; break
        if re.search(r"class\s*=\s*'[^']*\b"+re.escape(cname)+r"\b[^']*'", html_body):
            used=True; break
        # also check id or generic mentions (less strict)
    if used:
        kept_rules.append(rule)
    else:
        removed += 1
print('Removed', removed, 'unused CSS blocks')
new_css = '\n'.join(kept_rules)
new_text = text[:m.start(2)] + new_css + text[m.end(2):]
# prettify using BeautifulSoup, install if necessary
try:
    from bs4 import BeautifulSoup
except Exception:
    print('BeautifulSoup not installed; attempting pip install...')
    subprocess.check_call([sys.executable,'-m','pip','install','beautifulsoup4','lxml'])
    from bs4 import BeautifulSoup
soup = BeautifulSoup(new_text, 'lxml')
pretty = soup.prettify()
p.write_text(pretty, encoding='utf-8')
print('Wrote prettified HTML to', p)
