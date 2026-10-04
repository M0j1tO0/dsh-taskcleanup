import json, sys, struct, os, re

ASAR = r"C:\Users\ASUS\AppData\Local\Programs\DeepSeek Harness\resources\app.asar"


class Asar:
    def __init__(self, path):
        self.path = path
        with open(path, "rb") as f:
            head = f.read(8)
            header_size = struct.unpack("<I", head[4:8])[0]
            raw = f.read(header_size)
        jlen = struct.unpack("<I", raw[4:8])[0]
        self.header = json.loads(raw[8:8 + jlen].decode("utf-8"))
        self.base = 8 + header_size

    def entries(self):
        out = []

        def walk(node, prefix):
            for name, meta in node.get("files", {}).items():
                p = prefix + "/" + name if prefix else name
                if "files" in meta:
                    walk(meta, p)
                else:
                    out.append((p, meta))
        walk(self.header, "")
        return out

    def read(self, meta):
        off = self.base + int(meta["offset"])
        with open(self.path, "rb") as f:
            f.seek(off)
            return f.read(int(meta["size"]))

    def text(self, meta):
        return self.read(meta).decode("utf-8", "replace")


def main():
    a = Asar(ASAR)
    ents = a.entries()
    mode = sys.argv[1] if len(sys.argv) > 1 else "list"
    print("TOTAL FILES:", len(ents), file=sys.stderr)

    if mode == "list":
        pats = [p.lower() for p in sys.argv[2:]]
        for p, m in ents:
            if not pats or any(x in p.lower() for x in pats):
                print(f"{m['size']:>10}  {p}")
    elif mode == "dump":
        target = sys.argv[2].replace("\\", "/").lstrip("/")
        for p, m in ents:
            if p == target:
                sys.stdout.buffer.write(a.read(m))
                return
        print("NOT FOUND", target, file=sys.stderr)
        sys.exit(2)
    elif mode == "cat":
        target = sys.argv[2].replace("\\", "/").lstrip("/")
        start = int(sys.argv[3]) if len(sys.argv) > 3 else 1
        count = int(sys.argv[4]) if len(sys.argv) > 4 else 150
        for p, m in ents:
            if p == target:
                lines = a.text(m).splitlines()
                for i in range(start - 1, min(len(lines), start - 1 + count)):
                    print(f"{i+1:>5}| {lines[i]}")
                print(f"[total lines: {len(lines)}]")
                return
        print("NOT FOUND", target, file=sys.stderr)
        sys.exit(2)
    elif mode == "grep":
        inc = sys.argv[2].replace("\\", "/").lstrip("/")
        rx = re.compile(sys.argv[3])
        ctx = int(sys.argv[4]) if len(sys.argv) > 4 else 1
        maxhits = int(sys.argv[5]) if len(sys.argv) > 5 else 200
        hits = 0
        for p, m in ents:
            if not p.startswith(inc):
                continue
            if m["size"] > 8_000_000:
                continue
            lines = a.text(m).splitlines()
            for i, ln in enumerate(lines):
                if rx.search(ln):
                    lo = max(0, i - ctx)
                    hi = min(len(lines), i + ctx + 1)
                    print(f"--- {p}:{i+1}")
                    for j in range(lo, hi):
                        print(f"{j+1:>6}| {lines[j][:400]}")
                    hits += 1
                    if hits >= maxhits:
                        print("... hit cap reached")
                        return


main()
