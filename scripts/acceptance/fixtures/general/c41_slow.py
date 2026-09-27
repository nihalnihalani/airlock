# ACCEPTANCE diagnostic (verifier_tester, C41): sleep 20 s, then APPEND one line to outputs/marker.txt.
# Appending (not overwriting) makes a duplicate execution in the same workspace visible as two lines.
import os, secrets, socket, time
t0 = time.time()
time.sleep(20)
os.makedirs("outputs", exist_ok=True)
with open("outputs/marker.txt", "a") as f:
    f.write(f"run {secrets.token_hex(8)} host={socket.gethostname()} started={t0:.3f} finished={time.time():.3f}\n")
print("marker written")
