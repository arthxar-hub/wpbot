import os
import time
from instagrapi import Client

USERNAME = "kaev0x"
PASSWORD = "artharfxks"
INTERVAL = 5

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

images = [
    os.path.join(BASE_DIR, f)
    for f in os.listdir(BASE_DIR)
    if f.lower().endswith((".jpg", ".jpeg", ".png"))
]

if not images:
    print("No images found in script folder")
    exit()

cl = Client()
cl.login(USERNAME, PASSWORD)

print("Profile picture changer started")

while True:
    for img in images:
        try:
            cl.account_change_picture(img)
            print("Changed profile picture:", os.path.basename(img))
            time.sleep(INTERVAL)
        except Exception as e:
            print("Error:", e)
            time.sleep(30)