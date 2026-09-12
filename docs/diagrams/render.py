"""Rebuild editable Embyfin SVGs. Rasterize them separately with an SVG renderer."""
from pathlib import Path
from html import escape

OUT = Path(__file__).parent
INK = '#17283E'
MUTED = '#52647A'
BLUE = '#2563A6'
TEAL = '#167D78'
PURPLE = '#7752A3'
AMBER = '#AF7322'
GRAY = '#748399'

ICONS = {
    'browser': '<rect x="5" y="8" width="54" height="39" rx="4"/><path d="M5 18h54M24 47v9m16-9v9M18 57h28"/><circle cx="11" cy="13" r="1"/><circle cx="17" cy="13" r="1"/><path d="m28 26 12 7-12 7Z"/>',
    'shield': '<path d="M32 4 54 13v16c0 15-11 24-22 31C21 53 10 44 10 29V13Z"/><path d="m21 31 8 8 15-17"/>',
    'worker': '<rect x="12" y="12" width="40" height="40" rx="7"/><path d="M22 4v8m10-8v8m10-8v8M22 52v8m10-8v8m10-8v8M4 22h8m-8 10h8m-8 10h8m40-20h8m-8 10h8m-8 10h8m-35-20-7 10h10l-7 10"/>',
    'database': '<ellipse cx="32" cy="12" rx="24" ry="9"/><path d="M8 12v38c0 12 48 12 48 0V12M8 30c0 12 48 12 48 0"/>',
    'bucket': '<ellipse cx="32" cy="12" rx="25" ry="9"/><path d="m7 12 6 40c2 10 36 10 38 0l6-40"/><path d="m27 29 13 8-13 8Z"/>',
    'poster': '<ellipse cx="32" cy="12" rx="25" ry="9"/><path d="m7 12 6 40c2 10 36 10 38 0l6-40"/><rect x="20" y="26" width="24" height="20" rx="2"/><path d="m21 42 7-7 5 5 4-4 6 6"/><circle cx="37" cy="31" r="2"/>',
    'backup': '<ellipse cx="32" cy="12" rx="25" ry="9"/><path d="m7 12 6 40c2 10 36 10 38 0l6-40"/><rect x="22" y="25" width="20" height="24" rx="2"/><path d="M26 32h12m-12 6h12m-12 6h8"/>',
    'processor': '<rect x="5" y="6" width="54" height="51" rx="5"/><path d="M5 18h54m-44 9 7 6-7 6m14 1h10M45 27v16m-4-12h8m-8 8h8"/>',
    'owner': '<circle cx="25" cy="17" r="10"/><path d="M7 52v-6c0-18 34-18 34 0v6"/><path d="m47 31 11 5v9c0 8-5 12-11 16-6-4-11-8-11-16v-9Z"/><path d="m42 44 4 4 7-8"/>',
    'clock': '<circle cx="31" cy="33" r="25"/><path d="M31 17v17l13 8M19 4h24"/>',
    'folder': '<path d="M5 18V9h21l8 9h25v36H5Z"/><path d="M5 26h54"/>',
}


class SVG:
    def __init__(self, title, subtitle, num, height=1260):
        self.height = height
        self.items = [f'<svg xmlns="http://www.w3.org/2000/svg" width="1680" height="{height}" viewBox="0 0 1680 {height}" role="img" aria-labelledby="title desc">',
            f'<title id="title">{escape(title)}</title><desc id="desc">{escape(subtitle)} Proposed architecture from PRD.md, not a deployed system.</desc>',
            '<defs>']
        for name, color in [('blue', BLUE), ('teal', TEAL), ('gray', GRAY), ('purple', PURPLE), ('amber', AMBER)]:
            self.items.append(f'<marker id="{name}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M1 1 9 5 1 9" fill="none" stroke="{color}" stroke-width="1.7" stroke-linejoin="round"/></marker>')
        for name, paths in ICONS.items():
            self.items.append(f'<symbol id="{name}" viewBox="0 0 64 64">{paths}</symbol>')
        self.items.extend(['</defs>', '<rect width="1680" height="100%" fill="#F7F9FC"/>'])
        self.text(48, 56, f'EMBYFIN  /  {num}', 18, BLUE, weight=700, spacing=2)
        self.text(48, 108, title, 42, weight=700)
        self.text(48, 145, subtitle, 22, MUTED)
        self.badge(1300, 29, 332, 'PROPOSED · NOT DEPLOYED', '#E8EDF5', MUTED, size=17)

    def text(self, x, y, txt, size=23, color=INK, weight=400, anchor='start', spacing=0):
        self.items.append(f'<text x="{x}" y="{y}" font-family="Arial, Helvetica, sans-serif" font-size="{size}" fill="{color}" font-weight="{weight}" text-anchor="{anchor}" letter-spacing="{spacing}">{escape(txt)}</text>')

    def rect(self, x, y, w, h, fill='#FFF', stroke='#D9E1EA', radius=18, dash=''):
        self.items.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill}" stroke="{stroke}" stroke-width="1.7"'+(f' stroke-dasharray="{dash}"' if dash else '')+'/>')

    def badge(self, x, y, w, txt, fill='#EEF3FA', color=BLUE, size=18):
        self.rect(x,y,w,34,fill,fill,9)
        self.text(x+w/2,y+23,txt,size,color,700,'middle')

    def icon(self, kind, x, y, size=70, color=BLUE):
        self.items.append(f'<use href="#{kind}" x="{x}" y="{y}" width="{size}" height="{size}" fill="none" stroke="{color}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>')

    def node(self, x, y, w, h, kind, title, subtitle='', color=BLUE, fill='#FFFFFF', size=26):
        self.rect(x,y,w,h,fill)
        self.icon(kind,x+w/2-34,y+17,68,color)
        self.text(x+w/2,y+115,title,size,INK,700,'middle')
        for i,line in enumerate(subtitle.split('\n')):
            if line:
                self.text(x+w/2,y+145+i*27,line,20,MUTED,anchor='middle')

    def hnode(self,x,y,w,h,kind,title,subtitle='',color=BLUE,fill='#FFF'):
        self.rect(x,y,w,h,fill)
        self.icon(kind,x+18,y+(h-62)/2,62,color)
        self.text(x+98,y+h/2-3,title,25,weight=700)
        if subtitle:
            self.text(x+98,y+h/2+27,subtitle,20,MUTED)

    def line(self, points, color='blue', dash=False, both=False, label=None, lx=None, ly=None, size=20):
        colors={'blue':BLUE,'teal':TEAL,'gray':GRAY,'purple':PURPLE,'amber':AMBER}
        p=' '.join(f'{x},{y}' for x,y in points)
        self.items.append(f'<polyline points="{p}" fill="none" stroke="{colors[color]}" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round" marker-end="url(#{color})"'+(f' marker-start="url(#{color})"' if both else '')+(' stroke-dasharray="8 7"' if dash else '')+'/>')
        if label:
            self.text(lx,ly,label,size,colors[color],anchor='middle')

    def note(self,x,y,w,title,subtitle):
        self.rect(x,y,w,74,'#FFF7E9','#E3C891',12,'5 4')
        self.text(x+16,y+29,title,21,AMBER,700)
        self.text(x+16,y+55,subtitle,18,MUTED)

    def footer(self, note, y=None):
        y = y or self.height-66
        self.line([(48,y),(95,y)],'blue')
        self.text(108,y+6,'HTTPS',18,MUTED)
        self.line([(255,y),(302,y)],'gray',True)
        self.text(315,y+6,'App data / control',18,MUTED)
        self.line([(550,y),(597,y)],'teal')
        self.text(610,y+6,'Media / signed I/O',18,MUTED)
        self.line([(870,y),(917,y)],'purple',True)
        self.text(930,y+6,'Owner controls',18,MUTED)
        self.rect(1140,y-14,25,25,'#FFF7E9','#E3C891',5,'4 3')
        self.text(1178,y+6,'Release requirement / gate',18,MUTED)
        self.text(48,y+41,note,17,MUTED)

    def save(self,name):
        s='\n'.join(self.items+['</svg>'])
        assert '<title id="title">' in s and '<desc id="desc">' in s
        (OUT / f'{name}.svg').write_text(s)


def overview():
    s=SVG('High-level architecture','Cloudflare-only baseline: existing videos in R2, application state in D1.','01',1450)
    s.rect(345,180,1287,1170,'#FFF5EC','#E9CBAF',24)
    s.text(371,218,'Cloudflare',25,weight=700)
    s.text(535,218,'Provider boundary · not a private network',19,MUTED)

    s.line([(285,421),(390,421)],label='HTTPS',lx=337,ly=400)
    s.line([(600,421),(690,421)],label='Identity',lx=645,ly=399,size=18)
    s.line([(1040,324),(1240,324)],'gray',True,both=True,label='SQL',lx=1138,ly=303)
    s.line([(1040,550),(1150,550),(1150,505),(1240,505)],'gray',True)
    s.text(1140,476,'List / HEAD / Range',18,MUTED,anchor='middle')
    s.line([(1040,594),(1115,594),(1115,705),(1240,705)],'gray',True)
    s.text(1170,732,'Poster reads',17,MUTED,anchor='middle')
    s.line([(1040,615),(1070,615),(1070,1048),(1370,1048),(1370,1024)],'gray',True)
    s.text(1245,1076,'SQL exports',19,MUTED,anchor='middle')
    s.line([(625,806),(645,806),(645,590),(690,590)],'gray',True)
    s.text(501,688,'Scan · dispatch · export',19,MUTED,anchor='middle')
    s.line([(865,638),(865,780)],'gray',True,label='Dispatch / renew',lx=963,ly=740,size=18)
    s.line([(865,920),(865,1100)],'gray',True,label='Start / stop',lx=970,ly=1006,size=19)
    s.text(970,1035,'Hard deadline',18,MUTED,anchor='middle')
    s.line([(690,1190),(655,1190),(655,616),(690,616)],'blue',both=True)
    s.text(490,1012,'HTTPS · job API',19,BLUE,anchor='middle')
    s.text(490,1041,'Claims · heartbeats · results',18,BLUE,anchor='middle')
    s.line([(185,1050),(185,615),(494,615),(494,535)],'purple',True)
    s.text(307,595,'Owner settings',19,PURPLE,anchor='middle')
    s.line([(1200,1215),(1599,1215),(1599,505),(1500,505)],'teal')
    s.text(1393,1200,'HTTPS · signed reads',19,TEAL,anchor='middle')
    s.line([(1200,1158),(1544,1158),(1544,705),(1500,705)],'teal')
    s.text(1365,1138,'HTTPS · signed uploads',19,TEAL,anchor='middle')

    s.node(45,321,240,224,'browser','Web browser','Library + Folders\nNative video player')
    s.node(390,321,210,214,'shield','Cloudflare Access','Sign-in / admission',size=23)
    s.rect(690,278,350,360,'#FFFFFF','#AABFD8')
    s.icon('worker',824,303,80)
    s.text(865,425,'Cloudflare Worker',27,weight=700,anchor='middle')
    s.text(865,461,'UI · API · scans · streams',21,MUTED,anchor='middle')
    s.text(865,495,'Checks users + library grants',20,BLUE,anchor='middle')
    s.rect(714,525,302,86,'#EDF4FD','#C4D7EC',12)
    s.text(865,558,'Storage adapter',24,BLUE,700,'middle')
    s.text(865,587,'R2 implementation · app code',19,MUTED,anchor='middle')
    s.node(1240,241,260,151,'database','D1','Catalog · grants · history',color=PURPLE,size=28)
    s.node(1240,425,260,171,'bucket','R2 · originals','Existing · read-only',color=AMBER)
    s.node(1240,627,260,160,'poster','R2 · generated','Private poster images',color=TEAL)
    s.node(1240,854,260,170,'backup','R2 · backups','Private SQL exports',color=PURPLE)
    s.node(375,730,250,174,'clock','Cron Triggers','1m tick · due work',size=25)
    s.hnode(690,780,350,140,'worker','Durable Object','Run lifecycle · deadlines',PURPLE)
    s.hnode(690,1100,510,140,'processor','Cloudflare Container','Python / uv + FFprobe / FFmpeg',TEAL)
    s.hnode(45,1050,240,160,'owner','Owner','Grants · scans',PURPLE)
    s.note(369,1260,804,'Phase 0: accept measured playback, thumbnails, and budgets','One instance · bounded scratch · no durable media mirror')
    s.rect(1200,1270,400,57,'#F3F5F9','#A8B2C0',12,'6 5')
    s.text(1400,1305,'Later: AWS S3 storage adapter',22,MUTED,700,'middle')
    s.footer('Responses return along the request path. No processor → D1 or backup access. Operator recovery is described in the guide.',1380)
    s.save('01-architecture')


def ingestion():
    s=SVG('From bucket to searchable library','Discovery is fast catalog work; thumbnails require a separate video-processing step.','02',1650)
    s.rect(36,188,1608,321,'#FFFFFF','#DBE3ED',22)
    s.badge(59,208,176,'A  DISCOVER','#EDF2FB',BLUE)
    s.text(261,234,'Manual / daily start · Cron resumes bounded pages',22,MUTED)
    s.line([(283,350),(358,350)],label='Start',lx=320,ly=325,size=18)
    s.line([(570,350),(648,350)],'gray',True,label='List prefix',lx=609,ly=325,size=18)
    s.line([(868,350),(948,350)],'gray',True,label='Page',lx=908,ly=325,size=18)
    s.line([(1178,350),(1258,350)],'gray',True,label='Commit',lx=1218,ly=325,size=18)
    s.node(62,265,221,188,'clock','Owner / Cron','Start or resume',size=23)
    s.node(358,265,212,188,'worker','Worker','List one page')
    s.node(648,265,220,188,'bucket','R2 originals','Keys · sizes · revisions',AMBER,size=24)
    s.node(948,265,230,188,'worker','Worker','Normalize + upsert')
    s.node(1258,265,340,188,'database','D1 catalog','Rows + cursor + media jobs',PURPLE)
    s.text(61,487,'Commit records before advancing the cursor. Listing does not reveal duration, codecs, or thumbnails.',21,MUTED)

    s.rect(36,533,1608,309,'#F0F4FB','#CBD8EA',22)
    s.badge(59,553,176,'B  DISPATCH','#E0EAF9',BLUE)
    s.text(261,579,'In Cloudflare · start only when due jobs exist · 15-minute enrichment cadence',22,MUTED)
    s.line([(332,697),(393,697)],'gray',True,label='Tick',lx=362,ly=676,size=18)
    s.line([(653,697),(742,697)],'gray',True,label='RPC',lx=697,ly=676,size=18)
    s.line([(1132,697),(1215,697)],'gray',True,label='Start',lx=1174,ly=676,size=18)
    s.hnode(62,641,270,120,'clock','Cron Triggers','1m tick')
    s.hnode(393,641,260,120,'worker','Worker','Due work only')
    s.hnode(742,641,390,120,'worker','Durable Object','Generation · deadline',PURPLE)
    s.hnode(1215,641,383,120,'processor','Container','Bounded FFmpeg batch',TEAL)
    s.text(61,815,'One active run · deadline survives restarts · stop when idle · no container → D1 connection',21,MUTED)

    s.rect(36,866,1608,664,'#EFF8F7','#CAE2DD',22)
    s.badge(59,886,176,'C  ENRICH','#DFF0EC',TEAL)
    s.text(261,912,'Cloudflare Container · one video at a time · private object access',22,MUTED)
    s.line([(866,1026),(1132,1026)],'gray',True,both=True,label='Lease / finalize',lx=999,ly=1005)
    s.line([(632,1231),(632,1101)],'blue',both=True)
    s.text(477,1154,'1  Claim job',21,BLUE,anchor='middle')
    s.text(477,1183,'+ signed access',19,BLUE,anchor='middle')
    s.line([(819,1231),(819,1101)],'gray',True)
    s.text(972,1154,'4  Report completion',21,MUTED,anchor='middle')
    s.text(972,1183,'Revision must still match',18,MUTED,anchor='middle')
    s.line([(378,1308),(552,1308)],'teal',label='2  Video bytes',lx=465,ly=1284,size=19)
    s.line([(866,1308),(1132,1308)],'teal',label='3  Store poster',lx=999,ly=1284)
    s.hnode(552,965,314,136,'worker','Worker job API','Machine authentication')
    s.hnode(1132,965,466,136,'database','D1','Job state + technical metadata',PURPLE)
    s.node(63,1231,315,195,'bucket','R2 originals','Read assigned object only',AMBER)
    s.node(552,1231,314,195,'processor','FFprobe / FFmpeg','Probe + decode a frame',TEAL)
    s.node(1132,1231,466,195,'poster','R2 generated-assets bucket','Versioned poster · private access',TEAL)
    s.text(80,1038,'Direct R2 access uses',22,TEAL)
    s.text(80,1068,'short-lived signed URLs.',22,TEAL)
    s.text(80,1102,'No permanent source credentials',18,MUTED)
    s.text(80,1129,'are sent to the processor.',18,MUTED)
    s.text(66,1471,'Upload first, mark ready second.',21,MUTED)
    s.text(66,1500,'Stale results cannot replace current metadata or posters.',21,MUTED)
    s.note(910,1444,688,'Lease + revision checks reject stale completion','A restart revalidates its run; an expired job cannot publish.')
    s.footer('Repeated icons show the same components at different stages. Stop the batch when idle or overdue; keep results durable in D1 / R2.',1580)
    s.save('02-ingestion')


def viewing():
    s=SVG('Browse, watch, and continue','The browser uses the Worker; library queries and video bytes follow different paths.','03',1390)
    s.rect(36,187,1608,353,'#FFFFFF','#DBE3ED',22)
    s.badge(60,209,215,'A  BROWSE / SEARCH','#EDF2FB',BLUE)
    s.line([(295,364),(358,364)],label='HTTPS',lx=326,ly=342,size=17)
    s.line([(557,364),(635,364)],label='Identity',lx=596,ly=342,size=17)
    s.line([(958,322),(1250,322)],'gray',True,both=True,label='Catalog / grants / history',lx=1104,ly=302,size=19)
    s.line([(958,443),(1250,443)],'teal',both=True)
    s.text(1103,475,'Posters / image bytes',18,TEAL,anchor='middle')
    s.node(60,272,235,205,'browser','Web browser','Library + Folder view',size=25)
    s.node(358,272,199,205,'shield','Access','Admit identity',size=26)
    s.node(635,272,323,205,'worker','Worker','Check library permissions')
    s.hnode(1250,265,350,116,'database','D1','Names · paths · state',PURPLE)
    s.hnode(1250,401,350,116,'poster','R2 generated','Private posters',TEAL)
    s.text(61,516,'Search and folder navigation read D1. They do not scan the bucket or open every video.',21,MUTED)

    s.rect(36,565,1608,607,'#F0F4FB','#CBD8EA',22)
    s.badge(60,587,251,'B  PLAYBACK / PROGRESS','#E0EAF9',BLUE)
    s.text(336,613,'Every new media request checks access; original bytes stream with backpressure.',21,MUTED)
    lanes=[(160,'browser','Browser',BLUE),(555,'worker','Worker + adapter',BLUE),(1028,'database','D1',PURPLE),(1485,'bucket','R2 originals',AMBER)]
    for x,kind,title,color in lanes:
        s.icon(kind,x-28,640,56,color)
        s.text(x,727,title,23,INK,700,'middle')
        s.items.append(f'<line x1="{x}" y1="748" x2="{x}" y2="1141" stroke="#B9C7D9" stroke-width="1.5" stroke-dasharray="4 7"/>')
    s.line([(160,783),(555,783)],label='1  GET / HEAD · Range',lx=357,ly=768,size=19)
    s.line([(555,842),(1028,842)],'gray',True,label='2  Check enabled user + library grant',lx=791,ly=827,size=19)
    s.line([(555,901),(1485,901)],'gray',True,label='3  Conditional read · verify source revision',lx=1107,ly=886,size=19)
    s.line([(1485,960),(555,960)],'teal',label='4  Original video bytes · 200 / 206',lx=1107,ly=945,size=19)
    s.line([(555,1019),(160,1019)],'teal',label='5  Stream to player',lx=357,ly=1004,size=19)
    s.line([(160,1078),(555,1078)],'blue',label='6  Saved playback position',lx=357,ly=1063,size=19)
    s.line([(555,1137),(1028,1137)],'gray',True,label='7  Per-user progress / last watched',lx=791,ly=1122,size=19)
    s.note(49,1200,756,'Playback errors: keep uncertainty explicit','Check login / availability; allow an unknown or device-specific failure.')
    s.note(827,1200,804,'Account and content changes clear stale state','Sign-out clears visible account state; replacement clears recent activity.')
    s.footer('Direct originals only · no adaptive renditions or automatic transcoding. Range contract also includes 416 for unsatisfiable ranges.',1320)
    s.save('03-viewing')


if __name__ == '__main__':
    overview()
    ingestion()
    viewing()
    print('Wrote 3 editable SVG diagrams.')
