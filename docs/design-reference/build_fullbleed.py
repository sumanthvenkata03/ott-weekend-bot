#!/usr/bin/env python3
"""72nd NFA register v2 — FULL-BLEED 2x2 poster quadrants, zero gaps."""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import numpy as np, cv2

W,H=2160,2700
QW,QH=1080,1350
F='/home/claude/tbsi/fonts/'
GOLD=(242,212,138); CREAM=(246,240,228)
casc=cv2.CascadeClassifier(cv2.data.haarcascades+'haarcascade_frontalface_default.xml')

def pf(sz,w=800):
    f=ImageFont.truetype(F+'PlayfairDisplay.ttf',sz); f.set_variation_by_axes([w]); return f
def jb(sz,w=600):
    f=ImageFont.truetype(F+'JetBrainsMono.ttf',sz); f.set_variation_by_axes([w]); return f

def quad_img(src):
    img=Image.open(src).convert('RGB')
    a=np.array(img); g=cv2.cvtColor(a,cv2.COLOR_RGB2GRAY)
    fs=casc.detectMultiScale(g,1.06,4,minSize=(50,50))
    r=max(QW/img.width,QH/img.height)
    im2=img.resize((int(img.width*r)+1,int(img.height*r)+1),Image.LANCZOS)
    if len(fs):
        fy=min(y+h2/2 for x,y,w2,h2 in fs)*r
        y0=int(np.clip(fy-QH*0.28,0,im2.height-QH))
    else:
        y0=(im2.height-QH)//5
    q=im2.crop(((im2.width-QW)//2,y0,(im2.width-QW)//2+QW,y0+QH))
    return q.filter(ImageFilter.UnsharpMask(2,70,3))

def scrim(q,strength=0.92,span=0.52):
    arr=np.array(q).astype(np.float32)
    n=int(QH*span)
    a=np.zeros((QH,1),np.float32)
    a[QH-n:,0]=np.linspace(0,strength,n)**1.15
    arr=arr*(1-a[:,:,None])
    return Image.fromarray(np.clip(arr,0,255).astype(np.uint8))

def q_mono(d,text,px,ycenter,fill,track,weight,maxw,qx):
    f=jb(px,weight); tot=sum(f.getbbox(ch)[2]+track for ch in text)-track
    while tot>maxw:
        px-=1; f=jb(px,weight); tot=sum(f.getbbox(ch)[2]+track for ch in text)-track
    x=qx+(QW-tot)//2
    for ch in text: d.text((x,ycenter),ch,font=f,fill=fill); x+=f.getbbox(ch)[2]+track
    return px

def quad_text(c,qx,qy,cat,film,credit):
    d=ImageDraw.Draw(c)
    fpx=86; f=pf(fpx,800); tw=f.getbbox(film)[2]
    while tw>QW-90: fpx-=4; f=pf(fpx,800); tw=f.getbbox(film)[2]
    base=qy+QH-96
    # credit (bottom)
    q_mono(d,credit,31,base,CREAM,4,500,QW-100,qx)
    # film serif above
    fy=base-28-f.getbbox(film)[3]
    d.text((qx+(QW-tw)//2,fy),film,font=f,fill=CREAM)
    # category above film (gold)
    cy=fy-58
    for ln in reversed(cat):
        q_mono(d,ln,30,cy,GOLD,6,700,QW-90,qx)
        cy-=48

def text_quad(c,qx,qy,kind,payload):
    """Typographic quadrant: 'film' big-serif block or 'list' also-honoured."""
    arr=np.zeros((QH,QW,3),np.float32)
    top=np.array([64,22,16],np.float32); bot=np.array([30,10,7],np.float32)
    g=np.linspace(0,1,QH)[:,None,None]
    arr=top[None,None]*(1-g)+bot[None,None]*g
    noise=np.random.default_rng(5).normal(0,6,(QH,QW,1))
    q=Image.fromarray(np.clip(arr+noise,0,255).astype(np.uint8))
    c.paste(q,(qx,qy))
    d=ImageDraw.Draw(c)
    if kind=='film':
        cat,film,credit=payload
        words=film.split(' ')
        fpx=150; f=pf(fpx,850)
        wmax=max(f.getbbox(w2)[2] for w2 in words)
        while wmax>QW-140: fpx-=6; f=pf(fpx,850); wmax=max(f.getbbox(w2)[2] for w2 in words)
        total=len(words)*int(fpx*1.12)
        yy=qy+(QH-total)//2-70
        for w2 in words:
            tw=f.getbbox(w2)[2]
            d.text((qx+(QW-tw)//2,yy),w2,font=f,fill=CREAM); yy+=int(fpx*1.12)
        quad_text_lines=cat
        cy=yy+34
        for ln in quad_text_lines:
            q_mono(d,ln,30,cy,GOLD,6,700,QW-90,qx); cy+=48
        q_mono(d,credit,31,cy+8,CREAM,4,500,QW-100,qx)
    else:
        title,rows=payload
        fpx=92; f=pf(fpx,800); tw=f.getbbox(title)[2]
        d.text((qx+(QW-tw)//2,qy+120),title,font=f,fill=CREAM)
        yy=qy+320
        for (gline,lines) in rows:
            q_mono(d,gline,30,yy,GOLD,6,700,QW-90,qx); yy+=52
            for ln in lines:
                q_mono(d,ln,30,yy,CREAM,4,500,QW-90,qx); yy+=48
            yy+=26

def pill_on(c):
    pill=Image.open('/home/claude/tbsi/assets/brand/handle_pill_2x.png').convert('RGBA')
    ph=96; pw=int(pill.width*ph/pill.height)
    sh=Image.new('RGBA',(pw+40,ph+40),(0,0,0,0))
    ImageDraw.Draw(sh).rounded_rectangle([20,20,pw+20,ph+20],ph//2,fill=(0,0,0,120))
    sh=sh.filter(ImageFilter.GaussianBlur(12))
    c.alpha_composite(sh,((W-pw)//2-20,52))
    c.paste(pill.resize((pw,ph),Image.LANCZOS),((W-pw)//2,64),pill.resize((pw,ph),Image.LANCZOS))

QUADS=[(0,0),(1080,0),(0,1350),(1080,1350)]

SLIDES=[
 [(['BEST FEATURE FILM'],'Article 370','DIR. ADITYA SUHAS JAMBHALE','nfa_yami.jpg'),
  (['BEST POPULAR FILM ·','WHOLESOME ENTERTAINMENT'],'Kalki 2898 AD','DIR. NAG ASHWIN','nfa_kalki.jpg'),
  (['BEST DIRECTION'],'Amaran','RAJKUMAR PERIASAMY','nfa_amaran.jpg'),
  (['BEST ACTOR · SHARED'],'Bramayugam','MAMMOOTTY','nfa_mammootty.jpg')],
 [(['BEST ACTOR · SHARED'],'Chandu Champion','KARTIK AARYAN','nfa_kartik.jpg'),
  (['BEST ACTRESS'],'Article 370','YAMI GAUTAM','nfa_yami.jpg'),
  (['BEST SUPPORTING ACTOR'],'Bhakshak','SANJAY MISHRA','nfa_bhakshak.jpg'),
  (['BEST SCREENPLAY · ORIGINAL'],'Pushpa 2','SUKUMAR','nfa_pushpa2.jpg')],
 [(['BEST DIALOGUE WRITER'],'Lucky Baskhar','VENKY ATLURI','nfa_luckyb.jpg'),
  (['BEST EDITING'],'Amaran','R KALAIVANNAN','nfa_amaran.jpg'),
  (['BEST CINEMATOGRAPHY'],'Bramayugam','SHEHNAD JALAL','nfa_mammootty.jpg'),
  (['BEST PRODUCTION DESIGNER'],'Kalki 2898 AD','NITIN ZIHANI CHOUDHARY','nfa_kalki.jpg')],
 [(['BEST COSTUME DESIGNER'],'Pushpa 2','DEEPALI NOOR & SHEETAL SHARMA','nfa_pushpa2.jpg'),
  (['BEST MAKE UP ARTIST'],'Committee Kurrollu','P RAVI KUMAR','nfa_ck.jpg'),
  (['BEST MUSIC DIRECTOR'],'Article 370','SHASHWAT SACHDEV','nfa_yami.jpg'),
  (['BEST BACKGROUND MUSIC'],'Amaran','G V PRAKASH KUMAR','nfa_amaran.jpg')],
 [(['BEST CHOREOGRAPHY'],'Stree 2','VIJAY GANGULY · AAJ KI RAAT','nfa_stree2.jpg'),
  (['BEST CHILDREN\u2019S FILM +','BEST CHILD ARTIST · SHARED'],'35',' ARUNDEV POTHULA + 4 CO-WINNERS','nfa_35.jpg'),
  (['BEST TELUGU FILM'],'Committee Kurrollu','DIR. YADHU VAMSEE','nfa_ck.jpg'),
  (['BEST TAMIL FILM'],'Raayan','DIR. DHANUSH · SUN TV','nfa_raayan.jpg')],
]

for si,slide in enumerate(SLIDES):
    c=Image.new('RGBA',(W,H))
    for (qx,qy),(cat,film,credit,art) in zip(QUADS,slide):
        q=scrim(quad_img(art))
        c.paste(q,(qx,qy))
        quad_text(c,qx,qy,cat,film,credit)
    pill_on(c)
    c.convert('RGB').filter(ImageFilter.UnsharpMask(2,80,3)).save(f'tree/fb_s{si+2}_2x.png')

# slide 7: FF, Srikanth, Captain Miller (typo quad), Also Honoured (list quad)
c=Image.new('RGBA',(W,H))
q=scrim(quad_img('nfa_ff.jpg')); c.paste(q,(0,0))
quad_text(c,0,0,['BEST MALAYALAM FILM'],'Feminichi Fathima','DIR. FASIL MUHAMMED')
q=scrim(quad_img('nfa_srikanth.jpg')); c.paste(q,(1080,0))
quad_text(c,1080,0,['BEST HINDI FILM'],'Srikanth','DIR. TUSHAR HIRANANDANI')
text_quad(c,0,1350,'film',(['BEST FILM · NATIONAL, SOCIAL','& ENVIRONMENTAL VALUES'],'Captain Miller','DHANUSH'))
text_quad(c,1080,1350,'list',('Also honoured.',[
 ('BEST SUPPORTING ACTRESS · SHARED',['SACHANA NAMIDASS · MAHARAJA','RAPSHREE VARKADY · MITHYA']),
 ('SPECIAL MENTION',['DHANUSH · CAPTAIN MILLER','MEIYAZHAGAN']),
 ('BEST DEBUT DIRECTOR',['RANDEEP HOODA · SAVARKAR']),
]))
pill_on(c)
c.convert('RGB').filter(ImageFilter.UnsharpMask(2,80,3)).save('tree/fb_s7_2x.png')

# cover: full-bleed Kalki, JN type
img=Image.open('nfa_kalki.jpg').convert('RGB')
r=max(W/img.width,H/img.height)
im2=img.resize((int(img.width*r)+1,int(img.height*r)+1),Image.LANCZOS)
a=np.array(img); g=cv2.cvtColor(a,cv2.COLOR_RGB2GRAY)
fs=casc.detectMultiScale(g,1.06,4,minSize=(80,80))
fy=min(y+h2/2 for x,y,w2,h2 in fs)*r if len(fs) else im2.height*0.3
y0=int(np.clip(fy-H*0.26,0,im2.height-H))
bg=im2.crop(((im2.width-W)//2,y0,(im2.width-W)//2+W,y0+H))
arr=np.array(bg).astype(np.float32)
n=int(H*0.62); al=np.zeros((H,1),np.float32); al[H-n:,0]=np.linspace(0,0.94,n)**1.1
alt=np.zeros((H,1),np.float32); alt[:400,0]=np.linspace(0.55,0,400)
al=np.maximum(al,alt)
arr=arr*(1-al[:,:,None])
noise=np.random.default_rng(3).normal(0,6,(H,W,1))
c=Image.fromarray(np.clip(arr+noise,0,255).astype(np.uint8)).convert('RGBA')
pill_on(c)
d=ImageDraw.Draw(c)
def cmono(text,px,ytop,fill=CREAM,track=8,weight=600,maxw=1980):
    f=jb(px,weight); tot=sum(f.getbbox(ch)[2]+track for ch in text)-track
    while tot>maxw:
        px-=1; f=jb(px,weight); tot=sum(f.getbbox(ch)[2]+track for ch in text)-track
    x=(W-tot)//2
    for ch in text: d.text((x,ytop),ch,font=f,fill=fill); x+=f.getbbox(ch)[2]+track
cmono('72ND NATIONAL FILM AWARDS · FOR 2024',44,236,track=9)
f=pf(560,900); tw=f.getbbox('72')[2]
d.text(((W-tw)//2,1180),'72',font=f,fill=GOLD)
f2=pf(140,800)
for i,ln in enumerate(['The complete','winners list.']):
    tw2=f2.getbbox(ln)[2]
    d.text(((W-tw2)//2,1900+i*180),ln,font=f2,fill=CREAM)
cmono('9 TELUGU WINS · ANNOUNCED JULY 18 · NEW DELHI',36,2320,fill=GOLD,track=6,weight=500)
cmono('EVERY CATEGORY · EVERY WINNER · SWIPE \u2192',36,2390,fill=CREAM,track=6,weight=500)
c.convert('RGB').filter(ImageFilter.UnsharpMask(2,85,3)).save('tree/fb_s1_2x.png')
print('full-bleed register built: 7 slides')
