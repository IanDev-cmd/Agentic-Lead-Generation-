"""Keyword searches for the lead desk agents.

The same stems live in lib/agents.js. A short topic such as "edtech" becomes
several company and people searches. The agent only reads public pages.
"""

LINKEDIN_STEMS = ("companies", "startups", "founders", "head of sales", "partnerships")
SOCIAL_STEMS = ("companies", "founders", "creators", "community", "product launch")
SOCIAL_PLATFORMS = ("X", "Instagram", "YouTube", "Reddit", "Facebook")


def keyword_plan(topic, channel="linkedin"):
    text = " ".join(str(topic or "").split())[:120]
    stems = SOCIAL_STEMS if channel == "social" else LINKEDIN_STEMS
    if not text:
        return []
    return [f"{text} {stem}" for stem in stems]


def build_task(topic, channel="linkedin"):
    keywords = keyword_plan(topic, channel)
    numbered = "\n".join(f"{index}. {keyword}" for index, keyword in enumerate(keywords, start=1))
    if channel == "social":
        where = (
            "Search public pages on "
            + ", ".join(SOCIAL_PLATFORMS)
            + ". Do not use LinkedIn."
        )
    else:
        where = "Search public LinkedIn company pages and public LinkedIn people pages."
    return "\n".join([
        "You are a read-only research agent.",
        "Run each keyword as its own search. Keep companies and people that match the topic.",
        where,
        "Do not log in. Do not send a message, a connection request, a follow, a like, or a post.",
        "Do not invent an email or a page you did not open.",
        f"Topic: {topic}",
        "Keyword searches:",
        numbered,
        "Finish with a short list of companies and a short list of people. Each line needs the public URL and one fact from that page.",
    ])
