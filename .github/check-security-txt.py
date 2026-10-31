# Fails if security.txt's Expires date is less than 60 days away (or past), or more than a year
# ahead (RFC 9116 asks for under a year). Run by .github/workflows/security-txt.yml.
#
#     python3 .github/check-security-txt.py site/.well-known/security.txt
import re
import sys
from datetime import datetime, timezone

WARN_DAYS = 60

path = sys.argv[1]
match = re.search(r"^Expires:\s*(\S+)", open(path).read(), re.M | re.I)
if not match:
    print(f"::error file={path}::security.txt has no Expires line.")
    sys.exit(1)
expires = datetime.fromisoformat(match.group(1).replace("Z", "+00:00"))
days = (expires - datetime.now(timezone.utc)).days
print(f"security.txt expires {expires:%-d %B %Y}: {days} days from now.")
if days < WARN_DAYS:
    when = f"expired {-days} days ago" if days < 0 else f"expires in {days} days"
    print(f"::error file={path}::security.txt {when}. Move its Expires date on, to at most a year from today.")
    sys.exit(1)
if days > 366:
    print(f"::error file={path}::security.txt's Expires date is more than a year ahead; RFC 9116 asks for less.")
    sys.exit(1)
