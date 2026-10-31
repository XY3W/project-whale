"""Create deterministic shared wood + glyph atlas using OFL Source Han Sans."""
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
import math,random,json,hashlib,shutil
P=Path.cwd();O=P/'public/models/xiangqi-v1';A=P/'assets/xiangqi-v1';O.mkdir(exist_ok=True,parents=True)
font=A/'fonts/SourceHanSansCN-Regular.otf';f=ImageFont.truetype(str(font),350);rng=random.Random(81)
wood=Image.new('RGB',(512,512));px=wood.load()
for y in range(512):
 for x in range(512):
  v=3*math.sin(x*.18+2*math.sin(y*.009))+1.3*math.sin(x*.62+y*.03)+rng.uniform(-.7,.7)
  px[x,y]=(int(224+v),int(193+v),int(147+v))
wood.save(O/'wood.png');atlas=Image.new('RGB',(2048,2048),(224,193,147));items=[]
for k,(side,glyph)in enumerate([(s,c)for s,cs in [('red','帅仕相马车炮兵'),('black','将士象马车炮卒')]for c in cs]):
 tile=wood.copy();d=ImageDraw.Draw(tile);color=(158,37,34)if side=='red'else(37,40,43)
 d.ellipse((31,31,481,481),outline=color,width=5);d.ellipse((42,42,470,470),outline=color,width=2)
 bb=d.textbbox((0,0),glyph,font=f);d.text(((512-(bb[2]-bb[0]))/2-bb[0],(512-(bb[3]-bb[1]))/2-bb[1]-4),glyph,font=f,fill=color)
 x=k%4;y=k//4;atlas.paste(tile,(x*512,y*512));items.append({'side':side,'glyph':glyph,'tile':[x,y],'uvRect':[x/4,1-(y+1)/4,(x+1)/4,1-y/4]})
atlas.save(O/'glyph_atlas.png');(O/'glyphs.json').write_text(json.dumps(items,ensure_ascii=False,indent=2))
shutil.copy2(A/'fonts/LICENSE.txt',O/'FONT_LICENSE.txt')
(A/'fonts/SOURCE.json').write_text(json.dumps({'font':'Source Han Sans CN Regular','source':'https://github.com/adobe-fonts/source-han-sans/tree/release/SubsetOTF/CN','fileSha256':hashlib.sha256(font.read_bytes()).hexdigest(),'license':'SIL Open Font License 1.1','usage':'Unmodified font used to rasterize glyph_atlas.png; no runtime font dependency.'},indent=2))
print('atlas created',len(items))
# Board: real 9x10 intersections, river gap, palaces and conventional markers.
W,H=11.5,11.5;N=2048;board=wood.resize((N,N));d=ImageDraw.Draw(board);line=(85,51,25)
def pt(x,z):return ((x*1.15/W+.5)*N,(z*1.15/H+.5)*N)
def ln(a,b,width=3):d.line([pt(*a),pt(*b)],fill=line,width=width)
for row in range(10):z=(row-4.5)*1.0;ln((-4.,z),(4.,z),4 if row in [0,9]else 3)
for col in range(9):
 x=(col-4)*1.0
 if col in [0,8]:ln((x,-4.5),(x,4.5),4)
 else:ln((x,-4.5),(x,-.5));ln((x,.5),(x,4.5))
for ra,rb in [(0,2),(7,9)]:
 ln((-1.,(ra-4.5)*1.0),(1.,(rb-4.5)*1.0));ln((1.,(ra-4.5)*1.0),(-1.,(rb-4.5)*1.0))
for row,cols in [(2,[1,7]),(3,[0,2,4,6,8]),(6,[0,2,4,6,8]),(7,[1,7])]:
 for col in cols:
  x=(col-4)*1.0;z=(row-4.5)*1.0
  for sx in [-1,1]:
   if col==0 and sx<0 or col==8 and sx>0:continue
   for sz in [-1,1]:ln((x+.07*sx,z+.07*sz),(x+.15*sx,z+.07*sz),2);ln((x+.07*sx,z+.07*sz),(x+.07*sx,z+.15*sz),2)
bf=ImageFont.truetype(str(font),126)
for text,x,angle in [('楚 河',-1.65,0),('汉 界',1.65,180)]:
 label=Image.new('RGBA',(600,220),(0,0,0,0))
 ImageDraw.Draw(label).text((300,110),text,font=bf,fill=(*line,255),anchor='mm')
 label=label.rotate(angle)
 cx,cy=pt(x,0);board.paste(label,(round(cx-label.width/2),round(cy-label.height/2)),label)
d.rectangle((22,22,N-22,N-22),outline=line,width=6)
board.save(O/'board_atlas.png')
