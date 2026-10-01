# Networking and ports

![The Network tab saying what no forwarding rule can fix: a port the container never opened](/api/wiki/images/network-ports.png)

The portal is a web app and hides behind a tunnel; **the game servers do
not**. Players connect straight to the game over its own protocol, so each
game port must be forwarded on the router. A reverse proxy cannot help with
that, and neither can the tunnel.

## The Network tab

Per server, three answers side by side:

- **What friends connect to** — the public IP as the outside world sees it.
- **What must be forwarded** — the ports this container publishes, with
  administrative-looking ones (RCON, web consoles) flagged and never
  pre-selected: forwarding a game port lets people play, forwarding an admin
  console puts it on the internet.
- **What the router says** — when a UniFi router is connected, the actual
  rules, with one-click creation of the missing ones.

## The check forwarding cannot do

Forwarding only acts on ports a container publishes — it is blind to a port
the container never opened. GameKeepr's game registry knows what each
recognised game actually needs and says outright when one is missing: *"this
container does not publish 16262/udp, which this game needs."* That is the
failure where a server looks healthy, appears in the browser, and nobody can
join. Fixing it means adding the port mapping on the container (Unraid → edit
container) or redeploying — new deploys get missing required ports filled in
automatically.

## Which network a server joins

Every server deployed through the portal joins GameKeepr's own Docker
network, so the portal reaches the game by container name for player counts —
no LAN addresses to keep in sync.
