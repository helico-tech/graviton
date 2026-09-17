"""Q3: do the Python and JS ports of the same kernels agree BIT FOR BIT?
If they do, the algorithm's determinism does not depend on the host libm,
which is the whole point of writing our own kernels."""
import struct, importlib.util, io, contextlib, os, math
spec = importlib.util.spec_from_file_location("p3", os.path.join(os.path.dirname(os.path.abspath(__file__)), "p3_dtrig.py"))
p3 = importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()): spec.loader.exec_module(p3)

def hexf(x): return struct.pack('>d', x).hex()

JS = {
 "dsin 0.1": "3fb98eaecb8bcb2c", "dcos 0.1": "3fefd712f9a817c0",
 "dsin 1": "3feaed548f090cee", "dcos 1": "3fe14a280fb5068c",
 "dsin 3": "3fc210386db6d55b", "dcos 3": "bfefae04be85e5d2",
 "dsin 100": "bfe03425b78c4db8", "dcos 100": "3feb981dbf665fe0",
 "dsin 10000": "bfd38f2fa75d9289", "dcos 10000": "bfee780e88ec4409",
 "dsin 123456.789": "bfeff50e60ab53f9", "dcos 123456.789": "3faa74d27c41b22a",
 "dexp 2.5": "40285d6fd931e0bb", "dlog 7.5": "40001e85798eb9a3",
 "datan2 3,-4": "4003fc176b7a8560",
 "kepE": "3ff99891ef075f19", "kepSin": "3feffc911cc33d00", "kepCos": "bf9da49742ff2801",
}

def solve_kepler(M, e):
    E = M + (0.85 * e if M < 3.141592653589793 else -0.85 * e)
    sE = cE = d = 0.0
    for _ in range(3):
        sE, cE = p3.dsincos(E)
        f0 = E - e*sE - M; f1 = 1.0 - e*cE; f2 = e*sE; f3 = e*cE
        d1 = -f0/f1
        d2 = -f0/(f1 + 0.5*d1*f2)
        d  = -f0/(f1 + 0.5*d2*f2 + d2*d2*f3/6.0)
        E = E + d
    return E, sE + cE*d, cE - sE*d

rows = []
for x in (0.1, 1.0, 3.0, 100.0, 10000.0, 123456.789):
    s, c = p3.dsincos(x)
    key = ("%g" % x) if x != 123456.789 else "123456.789"
    key = {"0.1":"0.1","1":"1","3":"3","100":"100","10000":"10000","123456.789":"123456.789"}[key]
    rows.append((f"dsin {key}", hexf(s)))
    rows.append((f"dcos {key}", hexf(c)))
rows.append(("dexp 2.5", hexf(p3.dexp(2.5))))
rows.append(("dlog 7.5", hexf(p3.dlog(7.5))))
rows.append(("datan2 3,-4", hexf(p3.datan2(3.0, -4.0))))
E, sE, cE = solve_kepler(1.0, 0.6)
rows += [("kepE", hexf(E)), ("kepSin", hexf(sE)), ("kepCos", hexf(cE))]

print("=" * 88)
print("Q3  CPython 3.12 vs Node 24 V8, same algorithm, same source constants")
print("=" * 88)
print(f"{'quantity':<18}{'CPython':<20}{'Node 24':<20}{'':>8}")
ok = True
for name, got in rows:
    exp = JS.get(name, "?")
    same = (got == exp)
    ok = ok and same
    print(f"{name:<18}{got:<20}{exp:<20}{'match' if same else 'DIFFER':>8}")
print()
print(f"  All bit patterns identical across runtimes: {ok}")
print()
print("  For contrast, the host libm calls the sim must not use:")
for x in (0.1, 1.0, 100.0, 10000.0):
    print(f"    Math.sin({x}) CPython bits = {hexf(math.sin(x))}   (V8 may differ by 1 ulp;")
print("     canyon-run measured exactly that for Math.cos(0.1) between Node and Chromium)")
