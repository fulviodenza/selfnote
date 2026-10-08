-- Keep the highlight's colour rather than discarding it.
--
-- The page body is Markdown and has nowhere to put a colour, so nothing renders
-- it yet. Storing it anyway means the information is not lost on the way in: a
-- client that sends it can get it back later, and a future reading view can use
-- it without asking every user to re-highlight their books.
alter table ingested_highlights add column color text;
