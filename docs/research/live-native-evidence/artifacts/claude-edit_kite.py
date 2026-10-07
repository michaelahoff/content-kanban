from PIL import Image
im = Image.open("kite-v1.png").convert("RGB")
px = im.load()
for y in range(im.height):
    for x in range(im.width):
        r, g, b = px[x, y]
        # blend factor: how far pixel is from cream toward red (handles antialiased edges)
        t = (255 - g) / (255 - 30) if g < 255 else 0
        t = max(0, min(1, (248 - g) / (248 - 30)))
        px[x, y] = tuple(round((1 - t) * c + t * k) for c, k in zip((255, 248, 220), (30, 70, 220)))
im.save("kite-v2.png")
