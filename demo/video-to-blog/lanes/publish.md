---
lane:              # set by the installer
action: publish
run: on-enter
publish:
  to: blog
  field: publishedUrl
advance: auto
routes:
  published: Published
---

# Publish

Frameboard does this step itself; no agent runs and nothing here is sent to one. When a card arrives, the publish action takes the card's saved outputs, the newest version of each filename (in this flow only the `index.html` that Draft saved), and copies them into the local site `blog`, which Frameboard serves at `/sites/blog/<slug>/` with the slug made from the card's title. It writes that address into Published URL, adds a line to the hand-off notes and follows the `published` route. To publish to a server instead, set `to: deploy@blog.example.com:/var/www/blog/posts` and `url: https://blog.example.com/posts`: Frameboard stages the files and sends them with rsync, using this computer's SSH key, which agents never see; that is why publishing is a lane action and not an agent's job. Run playbook here publishes again, replacing the page.
