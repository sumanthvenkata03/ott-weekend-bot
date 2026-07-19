#!/usr/bin/env python3
"""72nd NFA — The Complete Winners Register. 8 slides, 2x2 card grids, JN skin."""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import numpy as np, cv2

W,H=2160,2700
F='/home/claude/tbsi/fonts/'
GOLD=(242,212,138); CREAM=(244,236,220); DIM=(196,186,172); INK=(18,14,12)
casc=cv2.CascadeClassifier(cv2.data.haarcascades+'haarcascade_frontalface_default.xml')

def pf(sz,w=800):
    f=ImageFont.truetype(F+'PlayfairDisplay.ttf',sz); f.set_variation_by_axes([w]); return f
def jb(sz,w=500):
    f=ImageFont.truetype(F+'JetBrainsMono.ttf',sz); f.set_variation_by_axes([w]); return f

def base():
    arr=np.full((H,W,3),INK,np.float32)
    yy,xx=np.mgrid[0:H,0:W]
    r=np.sqrt(((xx-W/2)/(W/2))**2+((yy-H/2)/(H/2))**2)
    arr*=np.clip(1-0.22*np.clip(r-0.35,0,1)/0.65,0.78,1)[...,None]
    noise=np.random.default_rng(11).normal(0,6.5,(H,W,1))
    arr=np.clip(arr+noise,0,255)
    c=Image.fromarray(arr.astype(np.uint8)).convert('RGBA')
    pill=Image.open('/home/claude/tbsi/assets/brand/handle_pill_2x.png').convert('RGBA')
    ph=100; pw=int(pill.width*ph/pill.height)
    c.paste(pill.resize((pw,ph),Image.LANCZOS),((W-pw)//2,72),pill.resize((pw,ph),Image.LANCZOS))
    return c

def mono(c,text,px,ytop,fill=CREAM,track=8,weight=500,maxw=1980,cx=None,align='c'):
    f=jb(px,weight); tot=sum(f.getbbox(ch)[2]+track for ch in text)-track
    while tot>maxw:
        px-=1; f=jb(px,weight); tot=sum(f.getbbox(ch)[2]+track for ch in text)-track
    if align=='c': x=(W//2 if cx is None else cx)-tot//2
    else: x=cx
    d=ImageDraw.Draw(c)
    for ch in text: d.text((x,ytop),ch,font=f,fill=fill); x+=f.getbbox(ch)[2]+track
    return ytop+int(px*1.35)

def serif(c,text,px,ytop,fill=CREAM,maxw=2000,weight=800,cx=None,align='c'):
    f=pf(px,weight); tw=f.getbbox(text)[2]
    while tw>maxw: px-=4; f=pf(px,weight); tw=f.getbbox(text)[2]
    x=(W//2 if cx is None else cx)-tw//2 if align=='c' else cx
    ImageDraw.Draw(c).text((x,ytop),text,font=f,fill=fill)
    return ytop+f.getbbox(text)[3]

def thumb(src,tw,th):
    img=Image.open(src).convert('RGB')
    a=np.array(img); g=cv2.cvtColor(a,cv2.COLOR_RGB2GRAY)
    fs=casc.detectMultiScale(g,1.06,4,minSize=(50,50))
    r=max(tw/img.width,th/img.height)
    im2=img.resize((int(img.width*r)+1,int(img.height*r)+1),Image.LANCZOS)
    if len(fs):
        fy=min(y+h2/2 for x,y,w2,h2 in fs)*r
        y0=int(np.clip(fy-th*0.30,0,im2.height-th))
    else:
        y0=(im2.height-th)//5
    return im2.crop(((im2.width-tw)//2,y0,(im2.width-tw)//2+tw,y0+th)).filter(ImageFilter.UnsharpMask(2,70,3))

def card(c,cx0,cy0,num,cat_lines,film,credit,art):
    TW,TH=400,560
    d=ImageDraw.Draw(c)
    if art:
        t=thumb(art,TW,TH)
        c.paste(t,(cx0,cy0))
        d.rectangle([cx0-4,cy0-4,cx0+TW+4,cy0+TH+4],outline=GOLD,width=2)
    else:
        d.rectangle([cx0,cy0,cx0+TW,cy0+TH],fill=(28,22,19))
        d.rectangle([cx0-4,cy0-4,cx0+TW+4,cy0+TH+4],outline=GOLD,width=2)
        fpx=64; f2=pf(fpx,800)
        words=film.split(' ')
        yy=cy0+TH//2-len(words)*40
        for wrd in words:
            tw2=f2.getbbox(wrd)[2]
            while tw2>TW-40: fpx-=4; f2=pf(fpx,800); tw2=f2.getbbox(wrd)[2]
            d.text((cx0+(TW-tw2)//2,yy),wrd,font=f2,fill=CREAM); yy+=int(fpx*1.15)
    tx=cx0+TW+36
    f3=pf(58,900)
    d.text((tx,cy0+6),f'\u2116{num:02d}',font=f3,fill=GOLD)
    y=cy0+110
    for ln in cat_lines:
        y=mono(c,ln,27,y,fill=DIM,track=4,weight=600,cx=tx,align='l',maxw=556)
    fpx=46; f4=pf(fpx,800)
    words=film.split(' ')
    lines=[]; cur=''
    for wrd in words:
        t2=(cur+' '+wrd).strip()
        if f4.getbbox(t2)[2]<=556: cur=t2
        else: lines.append(cur); cur=wrd
    lines.append(cur)
    y+=12
    for ln in lines:
        d.text((tx,y),ln,font=f4,fill=CREAM); y+=int(fpx*1.18)
    y+=14
    for ln in credit:
        y=mono(c,ln,25,y,fill=CREAM,track=4,weight=500,cx=tx,align='l',maxw=556)

def header(c,text):
    mono(c,'72ND NATIONAL FILM AWARDS · FOR THE YEAR 2024',40,252,fill=CREAM,track=8,weight=600)
    y=mono(c,text,34,320,fill=GOLD,track=7,weight=500)
    d=ImageDraw.Draw(c)
    d.line([(W-1900)/2,404,(W+1900)/2,404],fill=(196,154,63,160),width=2)

def footer(c):
    d=ImageDraw.Draw(c)
    d.line([(W-560)/2,2560,(W+560)/2,2560],fill=(196,154,63,200),width=2)
    mono(c,'THE BIG SCREEN INDEX',30,2588,fill=CREAM,track=8,weight=500)

CELLS=[(70,470),(1110,470),(70,1500),(1110,1500)]

CARDS=[
 (1,['BEST FEATURE FILM'],'Article 370',['DIR. ADITYA SUHAS JAMBHALE'],'nfa_yami.jpg'),
 (2,['BEST POPULAR FILM PROVIDING','WHOLESOME ENTERTAINMENT'],'Kalki 2898 AD',['DIR. NAG ASHWIN · VYJAYANTHI'],'nfa_kalki.jpg'),
 (3,['BEST DIRECTION'],'Amaran',['RAJKUMAR PERIASAMY'],'nfa_amaran.jpg'),
 (4,['BEST ACTOR · SHARED'],'Bramayugam',['MAMMOOTTY'],'nfa_mammootty.jpg'),
 (5,['BEST ACTOR · SHARED'],'Chandu Champion',['KARTIK AARYAN'],'nfa_kartik.jpg'),
 (6,['BEST ACTRESS'],'Article 370',['YAMI GAUTAM'],'nfa_yami.jpg'),
 (7,['BEST SUPPORTING ACTOR'],'Bhakshak',['SANJAY MISHRA'],'nfa_bhakshak.jpg'),
 (8,['BEST SCREENPLAY · ORIGINAL'],'Pushpa 2: The Rule',['SUKUMAR'],'nfa_pushpa2.jpg'),
 (9,['BEST DIALOGUE WRITER'],'Lucky Baskhar',['VENKY ATLURI'],'nfa_luckyb.jpg'),
 (10,['BEST EDITING'],'Amaran',['R KALAIVANNAN'],'nfa_amaran.jpg'),
 (11,['BEST CINEMATOGRAPHY'],'Bramayugam',['SHEHNAD JALAL'],'nfa_mammootty.jpg'),
 (12,['BEST PRODUCTION DESIGNER'],'Kalki 2898 AD',['NITIN ZIHANI CHOUDHARY'],'nfa_kalki.jpg'),
 (13,['BEST COSTUME DESIGNER'],'Pushpa 2: The Rule',['DEEPALI NOOR &','SHEETAL SHARMA'],'nfa_pushpa2.jpg'),
 (14,['BEST MAKE UP ARTIST'],'Committee Kurrollu',['P RAVI KUMAR'],'nfa_ck.jpg'),
 (15,['BEST MUSIC DIRECTOR'],'Article 370',['SHASHWAT SACHDEV'],'nfa_yami.jpg'),
 (16,['BEST BACKGROUND MUSIC'],'Amaran',['G V PRAKASH KUMAR'],'nfa_amaran.jpg'),
 (17,['BEST CHOREOGRAPHY'],'Stree 2',['VIJAY GANGULY · AAJ KI RAAT'],'nfa_stree2.jpg'),
 (18,['BEST CHILDREN\u2019S FILM'],'35 \u2013 Chinna Katha Kaadu',['DIR. NANDA KISHORE EMANI'],'nfa_35.jpg'),
 (19,['BEST CHILD ARTIST · SHARED \u00D75'],'35 \u2013 Chinna Katha Kaadu',['ARUNDEV POTHULA','+ FOUR CO-WINNERS'],'nfa_35.jpg'),
 (20,['BEST TELUGU FILM'],'Committee Kurrollu',['DIR. YADHU VAMSEE'],'nfa_ck.jpg'),
 (21,['BEST TAMIL FILM'],'Raayan',['DIR. DHANUSH · SUN TV'],'nfa_raayan.jpg'),
 (22,['BEST MALAYALAM FILM'],'Feminichi Fathima',['DIR. FASIL MUHAMMED'],'nfa_ff.jpg'),
 (23,['BEST HINDI FILM'],'Srikanth',['DIR. TUSHAR HIRANANDANI'],'nfa_srikanth.jpg'),
 (24,['BEST FILM · NATIONAL, SOCIAL &','ENVIRONMENTAL VALUES'],'Captain Miller',['DHANUSH'],None),
]

HEADS=['THE WINNERS LIST · \u211601\u201304','THE WINNERS LIST · \u211605\u201308','THE WINNERS LIST · \u211609\u201312','THE WINNERS LIST · \u211613\u201316','THE WINNERS LIST · \u211617\u201320','THE WINNERS LIST · \u211621\u201324']

# cover
c=base()
mono(c,'TBSI REGISTER · ANNOUNCED JULY 18 · NEW DELHI',42,268,fill=CREAM,track=8,weight=600)
serif(c,'The complete',150,470)
serif(c,'winners list.',150,680)
f=pf(560,900); tw=f.getbbox('72')[2]
d=ImageDraw.Draw(c)
d.text(((W-tw)//2,960),'72',font=f,fill=GOLD)
mono(c,'ND NATIONAL FILM AWARDS · FOR 2024',48,1720,fill=CREAM,track=10,weight=700)
mono(c,'9 TELUGU WINS · KALKI \u00D72 · PUSHPA 2 \u00D72 · CK \u00D72 · 35 \u00D72 · LB',34,1850,fill=GOLD,track=5,weight=500)
mono(c,'JURY CHAIR: JAYARAJ · 24 CARDS INSIDE \u2192',34,1912,fill=GOLD,track=5,weight=500)
f2=pf(58,600); txt='Every category. Every winner. On record.'
tw2=f2.getbbox(txt)[2]
d.text(((W-tw2)//2,2320),txt,font=f2,fill=CREAM)
footer(c)
c.convert('RGB').filter(ImageFilter.UnsharpMask(2,85,3)).save('tree/reg_s1_2x.png')

for s in range(6):
    c=base(); header(c,HEADS[s])
    for i in range(4):
        n,cat,film,cred,art=CARDS[s*4+i]
        card(c,CELLS[i][0],CELLS[i][1],n,cat,film,cred,art)
    footer(c)
    c.convert('RGB').filter(ImageFilter.UnsharpMask(2,85,3)).save(f'tree/reg_s{s+2}_2x.png')

# closer: also honoured
c=base()
mono(c,'72ND NATIONAL FILM AWARDS · FOR THE YEAR 2024',40,252,fill=CREAM,track=8,weight=600)
serif(c,'Also honoured.',130,400)
y=720
y=mono(c,'BEST SUPPORTING ACTRESS · SHARED',34,y,fill=GOLD,track=6,weight=600)
y=mono(c,'SACHANA NAMIDASS · MAHARAJA',36,y+4,track=5)
y=mono(c,'RAPSHREE VARKADY · MITHYA',36,y+2,track=5)
y=mono(c,'SPECIAL MENTION',34,y+52,fill=GOLD,track=6,weight=600)
y=mono(c,'DHANUSH · CAPTAIN MILLER',36,y+4,track=5)
y=mono(c,'MEIYAZHAGAN',36,y+2,track=5)
y=mono(c,'BEST DEBUT FILM OF A DIRECTOR',34,y+52,fill=GOLD,track=6,weight=600)
y=mono(c,'RANDEEP HOODA · SWATANTRYA VEER SAVARKAR',36,y+4,track=5)
y=mono(c,'BEST CINEMATOGRAPHY \u00B7 NON-FEATURE, ACTION, SOUND & MORE',28,y+52,fill=DIM,track=4,weight=500)
y=mono(c,'FULL OFFICIAL LIST: PIB · MINISTRY OF I&B',28,y+4,fill=DIM,track=4,weight=500)
sl=Image.open('tree/seal_smg_minimal.png').resize((340,340),Image.LANCZOS) if False else None
f2=pf(58,600); txt='The ceremony follows at Vigyan Bhawan.'
tw2=f2.getbbox(txt)[2]
ImageDraw.Draw(c).text(((W-tw2)//2,2300),txt,font=f2,fill=CREAM)
footer(c)
c.convert('RGB').filter(ImageFilter.UnsharpMask(2,85,3)).save('tree/reg_s8_2x.png')
print('register built: 8 slides')
