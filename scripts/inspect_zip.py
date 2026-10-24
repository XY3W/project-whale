import zipfile, sys

ZIP = "/Users/qiaonan/Downloads/完整绑定_V4.zip"

def real_name(info):
    n = info.filename
    if not (info.flag_bits & 0x800):
        try:
            n = n.encode("cp437").decode("gbk")
        except Exception:
            pass
    return n

z = zipfile.ZipFile(ZIP)
rows = []
for info in z.infolist():
    rows.append((real_name(info), info.file_size, info.is_dir()))

for n, s, d in rows:
    if d:
        continue
    print(f"{s/1e6:10.2f} MB  {n}")
