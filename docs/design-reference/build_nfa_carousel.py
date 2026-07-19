#!/usr/bin/env python3
"""72nd NFA South Report — 6 slides, Jana Nayagan skin."""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import numpy as np, cv2

W,H=2160,2700
F='/home/claude/tbsi/fonts/'
GOLD=(242,212,138); CREAM=(244,236,220); INK=(18,14,12)
casc=cv2.CascadeClassifier(cv2.data.haarcascades+'haarcascade_frontalface_default.xml')

def pf(sz,w=800):
    f=ImageFont.truetype(F+'PlayfairDisplay.ttf',sz); f.set_variation_by_axes([w]); return f
def jb(sz,w=500):
    f=ImageFont.truetype(F+'JetBrainsMono.ttf',sz); f.set_variation_by_axes([w]); return f

def wash_bg(files, dark=0.34):
    """Single or split poster background: cover-crop, darken, grain, vignette."""
    if len(files)==1:
        img=Image.open(files[0]).convert('RGB')
        a=np.array(img); g=cv2.cvtColor(a,cv2.COLOR_RGB2GRAY)
        fs=casc.detectMultiScale(g,1.06,4,minSize=(60,60))
        r=max(W/img.width,H/img.height)
        im2=img.resize((int(img.width*r)+1,int(img.height*r)+1),Image.LANCZOS)
        if len(fs):
            fy=min(y+h/2 for x,y,w2,h in fs)*r
            y0=int(np.clip(fy-H*0.30,0,im2.height-H))
        else:
            y0=(im2.height-H)//4
        bg=im2.crop(((im2.width-W)//2,y0,(im2.width-W)//2+W,y0+H))
    else:
        halfw=W//2
        parts=[]
        for fn in files:
            img=Image.open(fn).convert('RGB')
            r=max(halfw/img.width,H/img.height)
            im2=img.resize((int(img.width*r)+1,int(img.height*r)+1),Image.LANCZOS)
            a=np.array(img); g=cv2.cvtColor(a,cv2.COLOR_RGB2GRAY)
            fs=casc.detectMultiScale(g,1.06,4,minSize=(60,60))
            if len(fs):
                fy=min(y+h/2 for x,y,w2,h in fs)*r
                y0=int(np.clip(fy-H*0.28,0,im2.height-H))
            else:
                y0=(im2.height-H)//4
            parts.append(im2.crop(((im2.width-halfw)//2,y0,(im2.width-halfw)//2+halfw,y0+H)))
        bg=Image.new('RGB',(W,H))
        bg.paste(parts[0],(0,0)); bg.paste(parts[1],(halfw,0))
    arr=np.array(bg).astype(np.float32)*dark
    yy,xx=np.mgrid[0:H,0:W]
    r2=np.sqrt(((xx-W/2)/(W/2))**2+((yy-H/2)/(H/2))**2)
    arr*=np.clip(1-0.28*np.clip(r2-0.35,0,1)/0.65,0.72,1)[...,None]
    noise=np.random.default_rng(7).normal(0,7.5,(H,W,1))
    arr=np.clip(arr+noise,0,255)
    c=Image.fromarray(arr.astype(np.uint8)).convert('RGBA')
    if len(files)==2:
        d=ImageDraw.Draw(c); d.line([W//2,520,W//2,2100],fill=(196,154,63,120),width=2)
    pill=Image.open('/home/claude/tbsi/assets/brand/handle_pill_2x.png').convert('RGBA')
    ph=100; pw=int(pill.width*ph/pill.height)
    c.paste(pill.resize((pw,ph),Image.LANCZOS),((W-pw)//2,72),pill.resize((pw,ph),Image.LANCZOS))
    return c

def mono(c,text,px,ytop,fill=CREAM,track=10,weight=600,maxw=1980,cx=None):
    f=jb(px,weight); tot=sum(f.getbbox(ch)[2]+track for ch in text)-track
    while tot>maxw:
        px-=2; f=jb(px,weight); tot=sum(f.getbbox(ch)[2]+track for ch in text)-track
    cx=W//2 if cx is None else cx
    x=cx-tot//2; d=ImageDraw.Draw(c)
    sh=Image.new('RGBA',(W,H),(0,0,0,0)); sd=ImageDraw.Draw(sh)
    x2=x
    for ch in text: sd.text((x2+2,ytop+3),ch,font=f,fill=(0,0,0,150)); x2+=f.getbbox(ch)[2]+track
    c.alpha_composite(sh)
    for ch in text: d.text((x,ytop),ch,font=f,fill=fill); x+=f.getbbox(ch)[2]+track
    return ytop+int(px*1.4)

def serif(c,text,px,ytop,fill=CREAM,maxw=2000,weight=800):
    f=pf(px,weight); tw=f.getbbox(text)[2]
    while tw>maxw: px-=6; f=pf(px,weight); tw=f.getbbox(text)[2]
    d=ImageDraw.Draw(c)
    sh=Image.new('RGBA',(W,H),(0,0,0,0))
    ImageDraw.Draw(sh).text(((W-tw)//2+4,ytop+6),text,font=f,fill=(0,0,0,170))
    c.alpha_composite(sh)
    d.text(((W-tw)//2,ytop),text,font=f,fill=fill)
    return ytop+f.getbbox(text)[3]

def gold_serif(c,text,px,ytop,maxw=2000):
    f=pf(px,900); tw=f.getbbox(text)[2]
    while tw>maxw: px-=8; f=pf(px,900); tw=f.getbbox(text)[2]
    d=ImageDraw.Draw(c)
    sh=Image.new('RGBA',(W,H),(0,0,0,0))
    ImageDraw.Draw(sh).text(((W-tw)//2+5,ytop+8),text,font=f,fill=(0,0,0,180))
    c.alpha_composite(sh)
    d.text(((W-tw)//2,ytop),text,font=f,fill=GOLD)
    return ytop+f.getbbox(text)[3]

def footer(c,line1,line2=None):
    d=ImageDraw.Draw(c)
    d.line([(W-560)/2,2532,(W+560)/2,2532],fill=(196,154,63,200),width=2)
    y=mono(c,line1,30,2560,fill=CREAM,track=6,weight=500,maxw=1960)
    if line2: mono(c,line2,30,y-6,fill=CREAM,track=6,weight=500,maxw=1960)

OUT='tree/'
# ---------- S1 COVER ----------
c=wash_bg(['nfa_kalki.jpg'],dark=0.30)
mono(c,'TBSI SPECIAL · 72ND NATIONAL FILM AWARDS',44,252,track=9)
mono(c,'FOR THE YEAR 2024 · ANNOUNCED JULY 18',34,320,fill=GOLD,track=7,weight=500)
serif(c,"Telugu's big night.",148,470)
b=gold_serif(c,'8',560,720)
mono(c,'NATIONAL AWARDS',56,b+40,track=14,weight=700)
mono(c,'KALKI ×2 · PUSHPA 2 ×2 · 35 ×2',36,b+180,fill=GOLD,track=6,weight=500)
mono(c,'LUCKY BASKHAR · COMMITTEE KURROLLU',36,b+240,fill=GOLD,track=6,weight=500)
f=pf(62,600); txt='From a 2898 AD epic to a village comedy — the sweep.'
tw=f.getbbox(txt)[2]
while tw>1900: f=pf(f.size-4,600); tw=f.getbbox(txt)[2]
d=ImageDraw.Draw(c)
sh=Image.new('RGBA',(W,H),(0,0,0,0)); ImageDraw.Draw(sh).text(((W-tw)//2+3,2320+5),txt,font=f,fill=(0,0,0,170)); c.alpha_composite(sh)
d.text(((W-tw)//2,2320),txt,font=f,fill=CREAM)
footer(c,'FEATURE FILMS · CENTRAL JURY CHAIR: JAYARAJ','SWIPE FOR THE FULL SOUTH REPORT \u2192')
c.convert('RGB').filter(ImageFilter.UnsharpMask(2,90,3)).save(OUT+'nfa_s1_2x.png')

# ---------- S2 KALKI ----------
c=wash_bg(['nfa_kalki.jpg'],dark=0.36)
mono(c,'THE TELUGU SWEEP · 1 OF 3',44,252,track=9)
serif(c,'Kalki 2898 AD',170,420)
b=gold_serif(c,'\u00D72',420,700)
y=mono(c,'BEST POPULAR FILM PROVIDING',40,b+90,track=6)
y=mono(c,'WHOLESOME ENTERTAINMENT',40,y-6,track=6)
y=mono(c,'BEST PRODUCTION DESIGNER · NITIN ZIHANI CHOUDHARY',34,y+34,fill=GOLD,track=5,weight=500)
f=pf(58,600); txt='Part 1 takes national gold. Part 2 is loading.'
tw=f.getbbox(txt)[2]
d=ImageDraw.Draw(c)
sh=Image.new('RGBA',(W,H),(0,0,0,0)); ImageDraw.Draw(sh).text(((W-tw)//2+3,2300+5),txt,font=f,fill=(0,0,0,170)); c.alpha_composite(sh)
d.text(((W-tw)//2,2300),txt,font=f,fill=CREAM)
footer(c,'VYJAYANTHI MOVIES · DIR. NAG ASHWIN')
c.convert('RGB').filter(ImageFilter.UnsharpMask(2,90,3)).save(OUT+'nfa_s2_2x.png')

# ---------- S3 WRITERS ----------
c=wash_bg(['nfa_pushpa2.jpg','nfa_luckyb.jpg'],dark=0.34)
mono(c,'THE TELUGU SWEEP · 2 OF 3',44,252,track=9)
serif(c,'The writing table.',150,430)
b=gold_serif(c,'\u00D73',420,680)
y=mono(c,'PUSHPA 2 \u2014 BEST SCREENPLAY · ORIGINAL · SUKUMAR',36,b+90,track=5)
y=mono(c,'PUSHPA 2 \u2014 BEST COSTUME DESIGNER',36,y+16,track=5)
y=mono(c,'DEEPALI NOOR & SHEETAL SHARMA',32,y-8,fill=GOLD,track=5,weight=500)
y=mono(c,'LUCKY BASKHAR \u2014 BEST DIALOGUE WRITER · VENKY ATLURI',36,y+30,track=5)
f=pf(58,600); txt='Sukumar the writer gets his national due.'
tw=f.getbbox(txt)[2]
d=ImageDraw.Draw(c)
sh=Image.new('RGBA',(W,H),(0,0,0,0)); ImageDraw.Draw(sh).text(((W-tw)//2+3,2300+5),txt,font=f,fill=(0,0,0,170)); c.alpha_composite(sh)
d.text(((W-tw)//2,2300),txt,font=f,fill=CREAM)
footer(c,'PUSHPA 2: THE RULE · LUCKY BASKHAR')
c.convert('RGB').filter(ImageFilter.UnsharpMask(2,90,3)).save(OUT+'nfa_s3_2x.png')

# ---------- S4 HOMEGROWN ----------
c=wash_bg(['nfa_ck.jpg','nfa_35.jpg'],dark=0.34)
mono(c,'THE TELUGU SWEEP · 3 OF 3',44,252,track=9)
serif(c,'The homegrown wins.',150,430)
b=gold_serif(c,'\u00D73',420,680)
y=mono(c,'COMMITTEE KURROLLU \u2014 BEST TELUGU FILM',36,b+90,track=5)
y=mono(c,'DIR. YADHU VAMSEE · PINK ELEPHANT PICTURES',32,y-8,fill=GOLD,track=5,weight=500)
y=mono(c,'35 \u2013 CHINNA KATHA KAADU \u2014 BEST CHILDREN\u2019S FILM',36,y+30,track=5)
y=mono(c,'BEST CHILD ARTIST · SHARED · ARUNDEV POTHULA',32,y-8,fill=GOLD,track=5,weight=500)
f=pf(56,600); txt='A village committee and a mother\u2019s classroom carry the flag.'
tw=f.getbbox(txt)[2]
while tw>1920: f=pf(f.size-4,600); tw=f.getbbox(txt)[2]
d=ImageDraw.Draw(c)
sh=Image.new('RGBA',(W,H),(0,0,0,0)); ImageDraw.Draw(sh).text(((W-tw)//2+3,2300+5),txt,font=f,fill=(0,0,0,170)); c.alpha_composite(sh)
d.text(((W-tw)//2,2300),txt,font=f,fill=CREAM)
footer(c,'COMMITTEE KURROLLU · 35 \u2013 CHINNA KATHA KAADU')
c.convert('RGB').filter(ImageFilter.UnsharpMask(2,90,3)).save(OUT+'nfa_s4_2x.png')

# ---------- S5 TAMIL ----------
c=wash_bg(['nfa_amaran.jpg','nfa_raayan.jpg'],dark=0.34)
mono(c,'THE TAMIL WINS',44,252,track=10)
serif(c,"Tamil's night.",150,430)
b=gold_serif(c,'\u00D73',420,680)
y=mono(c,'AMARAN \u2014 BEST DIRECTION · RAJKUMAR PERIASAMY',36,b+90,track=5)
y=mono(c,'AMARAN \u2014 BEST BACKGROUND MUSIC · G V PRAKASH KUMAR',36,y+16,track=5)
y=mono(c,'RAAYAN \u2014 BEST TAMIL FILM · DIR. DHANUSH',36,y+16,track=5)
f=pf(58,600); txt='Dhanush adds a directing honour to the shelf.'
tw=f.getbbox(txt)[2]
d=ImageDraw.Draw(c)
sh=Image.new('RGBA',(W,H),(0,0,0,0)); ImageDraw.Draw(sh).text(((W-tw)//2+3,2300+5),txt,font=f,fill=(0,0,0,170)); c.alpha_composite(sh)
d.text(((W-tw)//2,2300),txt,font=f,fill=CREAM)
footer(c,'AMARAN · RAAYAN · SUN TV NETWORK')
c.convert('RGB').filter(ImageFilter.UnsharpMask(2,90,3)).save(OUT+'nfa_s5_2x.png')

# ---------- S6 NATIONAL ----------
c=wash_bg(['nfa_yami.jpg'],dark=0.30)
mono(c,'THE NATIONAL PICTURE',44,252,track=10)
serif(c,'The big ones.',150,430)
y=720
y=mono(c,'BEST FEATURE FILM \u2014 ARTICLE 370',40,y,track=6)
y=mono(c,'BEST ACTRESS \u2014 YAMI GAUTAM · ARTICLE 370',36,y+18,fill=GOLD,track=5,weight=500)
y=mono(c,'BEST ACTOR · SHARED \u2014 MAMMOOTTY · BRAMAYUGAM',36,y+34,track=5)
y=mono(c,'BEST ACTOR · SHARED \u2014 KARTIK AARYAN · CHANDU CHAMPION',36,y+16,track=5)
y=mono(c,'BEST HINDI FILM \u2014 SRIKANTH',36,y+34,fill=GOLD,track=5,weight=500)
y=mono(c,'BEST CHOREOGRAPHY \u2014 STREE 2 · AAJ KI RAAT',36,y+16,fill=GOLD,track=5,weight=500)
y=mono(c,'BEST SUPPORTING ACTOR \u2014 SANJAY MISHRA · BHAKSHAK',36,y+16,fill=GOLD,track=5,weight=500)
f=pf(58,600); txt='For the year 2024. The ceremony follows.'
tw=f.getbbox(txt)[2]
d=ImageDraw.Draw(c)
sh=Image.new('RGBA',(W,H),(0,0,0,0)); ImageDraw.Draw(sh).text(((W-tw)//2+3,2300+5),txt,font=f,fill=(0,0,0,170)); c.alpha_composite(sh)
d.text(((W-tw)//2,2300),txt,font=f,fill=CREAM)
footer(c,'72ND NATIONAL FILM AWARDS · THE BIG SCREEN INDEX')
c.convert('RGB').filter(ImageFilter.UnsharpMask(2,90,3)).save(OUT+'nfa_s6_2x.png')
print('six slides built')
