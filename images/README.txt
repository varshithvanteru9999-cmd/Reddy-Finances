ASSETS
======

Everything here is a placeholder from Wikimedia Commons. See CREDITS.txt
for the licence on each file. Replace them with client-owned media before
launch — most of the photos are CC BY / CC BY-SA and legally require
visible attribution.


HERO VIDEO  (client-supplied)
----------------------------
images/video/hero.mp4        Playing now. Porsche on a mountain road,
                             copied from Downloads/"rental video.mp4".
                             To change it, just overwrite this file.

                             For a .webm instead, edit the <source> in
                             index.html and change the type attribute.

Recommended: 16:9, 1920x1080, muted, 10-20s designed to loop, under 10 MB.
Darker footage works best -- white and red type sits on top of it.

images/hero/poster.png       A frame from the video, shown while it buffers.
                             Regenerate whenever the video changes, or the
                             poster will show the wrong car. Keep it
                             UNCROPPED -- the video element applies the
                             crop below to the poster as well.

WATERMARK COVER
---------------
The supplied clips have an AI generation watermark burned into the pixels.
It is NOT always in the same place: the single-Porsche clip carries it in
the bottom-LEFT on every frame, while the Porsche-and-Mustang clip carries
it bottom-RIGHT. So cropping one side is not enough.

css/style.css therefore covers BOTH bottom corners, via two radial patches
in the .hero-media::after background. They read as ordinary corner
vignetting and also lift contrast under the bottom rail.

  - watermark peeking out   -> enlarge --wm-size (in :root)
  - clean master supplied   -> delete the two radial-gradient lines from
                               .hero-media::after

This HIDES the watermark, it does not remove it. It is still in the file.
Truly removing it needs a re-encode (ffmpeg delogo, or re-export without a
watermark from whatever generated the clip). There is no ffmpeg on this
machine.

--vid-crop (in :root) is a separate, optional horizontal crop. It is set
to 0 and is not being used.


STILLS
------
images/hero/hero.jpg         No-video fallback for the hero.
images/hero/booking.jpg      Unused by the current design; kept for reuse.
images/hero/testimonials.jpg Unused by the current design; kept for reuse.
images/hero/why.jpg          Unused by the current design; kept for reuse.

images/cars/*.jpg            Vehicle photos. The filename must match the
                             `image` field in js/data.js, e.g.
                             images/cars/ford-f150.jpg
                             Cards crop 4:3, detail page 16:10.
                             1600x1200, under 300 KB.


ALSO WORTH REPLACING
--------------------
The logo swoosh is a placeholder shape in js/ui.js (ICON.swoosh). Drop the
real Reddy Finances mark in there.
