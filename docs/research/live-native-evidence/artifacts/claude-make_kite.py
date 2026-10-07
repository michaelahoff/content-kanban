from PIL import Image, ImageDraw
im = Image.new("RGB", (256, 256), (255, 248, 220))
ImageDraw.Draw(im).polygon([(128, 24), (216, 110), (128, 232), (40, 110)], fill=(220, 30, 40))
im.save("kite-v1.png")
