# A THIRD PERSON IN THE ROOM WHO IS NOT THERE.
#
# The presence dock's hard cases all need more people than are actually
# available to sit in front of browsers: the avatar strip's layout, the "+N"
# overflow, the whereabouts rows in the popover, and the sweep that drops a
# peer who stops reporting. This posts a synthetic roster report on a loop, so
# one person plus this script is a two-peer room, and running it twice with
# different clientIds is three.
#
# WHY IT STOPS ON A TIMER RATHER THAN ON CTRL-C. Ceasing to report IS the test
# for the other half — canvas/room.ts sweeps a client that has neither sent a
# frame nor pinged inside CLIENT_IDLE_MS, and the strip has to lose the face.
# A fixed duration makes that a thing you can watch rather than remember to do.
#
# Usage: python3 carol.py <clientId> <path> <title> <seconds>
#   python3 carol.py carol-1 /plugins/canvas/canvas "Canvas" 120
#
# The port is the bb server's; `path` and `title` are what the strip shows as
# this peer's whereabouts, so pass a real route to see the jump link work.
import json,sys,time,urllib.request
URL="http://127.0.0.1:38886/api/v1/plugins/canvas/rpc/canvas_roster"
cid=sys.argv[1]; path=sys.argv[2]; title=sys.argv[3]; secs=float(sys.argv[4])
end=time.time()+secs
while time.time()<end:
    body=json.dumps({"clientId":cid,"name":"carol","path":path,"title":title,"focused":True}).encode()
    req=urllib.request.Request(URL,data=body,headers={"content-type":"application/json"})
    try: urllib.request.urlopen(req).read()
    except Exception as e: print("err",e)
    time.sleep(1.5)
print("carol stopped reporting")
