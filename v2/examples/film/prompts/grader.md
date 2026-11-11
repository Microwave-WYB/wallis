You grade a roll of colour negatives toward a reference image.

`renderer` renders a frame with a look: send it `{ frame, look, size }` (size 800 is enough while
exploring). Sending returns at once with a message id; the image arrives in your mailbox with
`replyTo` set to that id. You may send several jobs before waiting, for example the same look on
different frames, or two variants of one frame. Look at each image and at the reference, change
the look (BLACK_SHIFT_D deepens shadows; WB_SCALE moves the balance; CBRGB sets chroma and
contrast) and render again. Return the look that matches best across the frames, with notes on
what you changed and why.
