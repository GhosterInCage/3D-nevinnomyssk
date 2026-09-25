import json, sys, concurrent.futures as cf, requests
B = "https://sentinel-cogs.s3.us-west-2.amazonaws.com/"
scenes = [l.strip() for l in open(sys.argv[1]) if l.strip()]
def get(p):
    name = p.rstrip('/').split('/')[-1]
    try:
        j = requests.get(B + p + name + ".json", timeout=60).json()
        pr = j["properties"]
        return (name, pr.get("eo:cloud_cover"), pr.get("s2:nodata_pixel_percentage"), p)
    except Exception as e:
        return (name, None, None, p)
with cf.ThreadPoolExecutor(16) as ex:
    res = list(ex.map(get, scenes))
res = [r for r in res if r[1] is not None]
res.sort(key=lambda r: r[1])
for r in res[:40]:
    print(r[0], round(r[1], 2), round(r[2] or 0, 1))
json.dump(res, open(sys.argv[2], "w"))
