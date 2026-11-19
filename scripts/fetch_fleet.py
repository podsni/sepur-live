"""Download the rolling-stock illustrations from Wikimedia Commons, resize to webp, and write credits.
Run: python3 scripts/fetch_fleet.py   (needs network + Pillow)"""
import json, re, io, urllib.request, urllib.parse
from PIL import Image
UA = {'User-Agent': 'SepurLive/1.0 (https://github.com/podsni/sepur-live)'}
FLEET = {
  'krl':     ('File:CLI-125 & JR 205 at Manggarai.jpg', 'KRL seri JR 205 / CLI-125', 'Rangkaian KRL Commuter Line (eks-JR 205 dan CLI-125 buatan INKA)'),
  'mrt':     ('File:Jakarta MRT train departing from ASEAN MRT Station.jpg', 'MRT Jakarta seri 1000 (Nippon Sharyo)', 'Kereta MRT Jakarta buatan Nippon Sharyo'),
  'lrtj':    ('File:Hyundai Rotem Jakarta LRT, Arriving at Boulevard Utara (cropped).jpg', 'LRV Hyundai Rotem', 'Kereta LRT Jakarta buatan Hyundai Rotem'),
  'jbdb':    ('File:Jabodebek LRV.jpg', 'LRV INKA (tanpa masinis)', 'Kereta LRT Jabodebek buatan INKA, otomatis tanpa masinis'),
  'whoosh':  ('File:KCIC400AF at Tegalluar Station.jpg', 'KCIC400AF (CR400AF)', 'Kereta cepat Whoosh KCIC400AF, turunan CR400AF Fuxing'),
  'ea203':   ('File:Railink EA203 passing Sudirman Station.jpg', 'KRL EA203 (INKA–Bombardier)', 'Rangkaian KA Bandara EA203'),
  'sky':     ('File:Soetta Skytrain 9.jpg', 'Skytrain Kalayang (Woojin / LEN)', 'Kereta penghubung antarterminal Bandara Soekarno-Hatta'),
  'argo':    ('File:Argo Semeru SSNG.jpg', 'Lokomotif CC 206 + kereta Stainless Steel New Generation', 'Rangkaian kereta Argo stainless steel generasi baru'),
  'ka':      ('File:Papandayan Train of Locomotive CC 206 16 10.jpg', 'Lokomotif CC 206 + rangkaian kereta', 'KA antarkota ditarik lokomotif diesel CC 206'),
  'lokal':   ('File:CC 201 78 04, Semarang Tawang Station, 2025 (01).jpg', 'Lokomotif CC 201 + rangkaian kereta', 'KA lokal ditarik lokomotif diesel CC 201'),
}
titles = '|'.join(v[0] for v in FLEET.values())
q = urllib.parse.urlencode({'action': 'query', 'format': 'json', 'titles': titles, 'prop': 'imageinfo', 'iiprop': 'url|extmetadata', 'iiurlwidth': 960,
                            'iiextmetadatafilter': 'LicenseShortName|LicenseUrl|Artist|Credit'})
d = json.load(urllib.request.urlopen(urllib.request.Request('https://commons.wikimedia.org/w/api.php?' + q, headers=UA)))
norm = {n['from']: n['to'] for n in d['query'].get('normalized', [])}
pages = {p['title']: p for p in d['query']['pages'].values()}
out, md = {}, ['# Kredit gambar armada', '', 'Gambar di `public/img/fleet/` adalah ilustrasi tipe armada yang umum dipakai tiap layanan, bukan foto unit yang sedang jalan. Semua diambil dari Wikimedia Commons, diperkecil dan diubah ke WebP (perubahan dari aslinya).', '']
strip = lambda s: re.sub(r'\s*\(talk · contribs\)', '', re.sub(r'\s+', ' ', re.sub('<[^>]+>', '', s or ''))).strip()
for key, (title, model, caption) in FLEET.items():
    p = pages[norm.get(title, title)]; ii = p['imageinfo'][0]; m = ii['extmetadata']
    img = Image.open(io.BytesIO(urllib.request.urlopen(urllib.request.Request(ii['thumburl'], headers=UA)).read())).convert('RGB')
    w, h = img.size; th = int(w * 9 / 16)
    if h > th: top = (h - th) // 2; img = img.crop((0, top, w, top + th))
    img = img.resize((640, 360), Image.LANCZOS)
    img.save(f'public/img/fleet/{key}.webp', 'WEBP', quality=72, method=6)
    lic = m.get('LicenseShortName', {}).get('value', '')
    rec = {'img': f'img/fleet/{key}.webp', 'model': model, 'caption': caption, 'author': strip(m.get('Artist', {}).get('value')), 'license': lic,
           'licenseUrl': m.get('LicenseUrl', {}).get('value', ''), 'source': ii['descriptionurl'], 'title': p['title'][5:]}
    out[key] = rec
    md.append(f"- **{model}** (`{key}.webp`): [{rec['title']}]({rec['source']}), oleh {rec['author']}, lisensi {lic}" + (f" ({rec['licenseUrl']})" if rec['licenseUrl'] else '') + '.')
json.dump(out, open('public/data/fleet.json', 'w'), ensure_ascii=False, indent=1)
open('ATTRIBUTION.md', 'w').write('\n'.join(md) + '\n')
print(json.dumps({k: (v['author'], v['license']) for k, v in out.items()}, ensure_ascii=False, indent=0))
