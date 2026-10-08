"""Freeze a deterministic synthetic owner history; no provider calls or private data."""

import argparse
import hashlib
import json
import sys
from pathlib import Path
from tempfile import NamedTemporaryFile

# Each row was authored and label ranges checked in this spike. These are fictional decisions.
# id, topic, initial fact, replacement fact, exact query, paraphrase, latest query
SUBJECTS = [
    (
        "japan",
        "Japan trip",
        "We almost booked the Shinjuku Airbnb Sora-17 near the station; its late arrival fee was 35 EUR. We did not book it.",
        "We booked an Ueno hotel with no late arrival fee instead of the tentative Shinjuku place.",
        "What was the fee at Sora-17?",
        "What fee did that place we almost booked near the station charge if we arrived late?",
        "Where are we staying on the Japan trip now?",
    ),
    (
        "apartment",
        "Tokyo apartment",
        "Meguro flat Mizu-4 is a seven-minute walk from the metro and requires a guarantor; it is a long-term lease, separate from the holiday.",
        "We rejected the Meguro lease and chose a Nakano flat with a corporate guarantor.",
        "What guarantor did Mizu-4 require?",
        "Did the long-term flat with the short walk to the metro need someone to guarantee the lease?",
        "Which Tokyo apartment did we choose?",
    ),
    (
        "pricing",
        "Kestrel pricing",
        "Product A, codename Kestrel, draft price card KC-180 offered 180 EUR annually and 20 EUR monthly. This was tentative.",
        "Pricing approved: Kestrel now costs 240 EUR annually and 24 EUR monthly; this replaces the 180 EUR draft.",
        "What did price card KC-180 say?",
        "How much were we originally going to charge for a whole year of the first product?",
        "What is the current annual Kestrel price?",
    ),
    (
        "launch",
        "Kestrel launch",
        "Release plan PRESS-OCT12 said we would tell reporters on October 12 after the closed beta, with 40 invited testers.",
        "The Kestrel announcement moved to October 19 because billing acceptance was unfinished.",
        "What date was PRESS-OCT12?",
        "When were we originally going to tell reporters about the first product?",
        "When is the Kestrel announcement now?",
    ),
    (
        "gym",
        "Gym log",
        "Workout BAR-72 used 72 kg squats in three sets of five; add two kilograms only after all reps are clean.",
        "The next squat session is 74 kg in three sets of five; skip increases if technique slips.",
        "What was the BAR-72 progression rule?",
        "How was I supposed to increase the weight after completing that squat workout cleanly?",
        "What weight is scheduled for the next squat session?",
    ),
    (
        "diet",
        "Diet",
        "Meal plan PRO-140 aimed for 140 grams of protein per day within 2200 calories, separate from lifting numbers.",
        "The dietitian raised protein to 155 grams per day and kept calories at 2200.",
        "What was the PRO-140 protein target?",
        "How much of the muscle-building nutrient did the original meal plan say to eat each day?",
        "What is my protein goal now?",
    ),
    (
        "cloud",
        "Cloud budget",
        "Edge budget EDGE-18 capped Workers and Vectorize at 18 USD per month; one vector had 1024 dimensions.",
        "The cloud budget is now 25 USD per month after the index grew; dimensions remain 1024.",
        "What monthly cap was EDGE-18?",
        "What monthly spending limit did we initially set for the edge hosting and search services?",
        "What is the updated cloud monthly cap?",
    ),
    (
        "auth",
        "Goblin auth",
        "Login policy OTP-8 expired one-time codes after eight minutes; cookie sessions lasted fourteen days.",
        "One-time login codes now expire after five minutes; cookie lifetime is unchanged.",
        "What expiry was specified in OTP-8?",
        "How long did a sign-in number remain usable under the earlier login policy?",
        "How long do login codes remain usable now?",
    ),
    (
        "crew",
        "Sidequest crew",
        "Task CREW-PINE acceptance required a video of the working demo and an exact commit receipt, before payment approval.",
        "Crew acceptance now also requires a replayable test receipt; the demo video is still required.",
        "What acceptance evidence did CREW-PINE require?",
        "What proof did the hired team need to hand over before we could approve their work?",
        "What evidence is required for crew acceptance now?",
    ),
    (
        "offline",
        "MyPlan offline",
        "Queue SYNC-LOCAL7 keeps unsent edits on the device while disconnected and merges them by revision on reconnect.",
        "Offline edits now use a conflict dialog for overlapping paragraphs instead of an automatic merge.",
        "What did SYNC-LOCAL7 keep on the device?",
        "What happened to notes I changed when the planning app had no network connection?",
        "How are overlapping offline paragraph edits resolved now?",
    ),
    (
        "camera",
        "Travel camera",
        "Camera kit LENS-28 was a 28 mm prime with a wrist strap; leave the heavy zoom at home for the Tokyo trip.",
        "The travel kit now includes a small 35 mm prime instead of the 28 mm lens.",
        "Which lens was in LENS-28?",
        "Which compact focal length did we first choose to carry for street pictures while travelling?",
        "Which focal length is in the travel kit now?",
    ),
    (
        "language",
        "Japanese practice",
        "Practice deck EKI-50 has fifty station phrases, with ten minutes of spoken review each morning.",
        "The language deck now adds restaurant phrases and moves spoken review to evenings.",
        "What review schedule did EKI-50 use?",
        "When did we originally plan to rehearse the phrases for finding our way around train stops?",
        "When do I practise spoken Japanese now?",
    ),
    (
        "office",
        "Home office",
        "Desk plan ARM-NORTH puts the monitor arm on the north edge so the window light comes from the left.",
        "The monitor arm moved to the west edge because the north clamp hit a cable tray.",
        "Where did ARM-NORTH put the monitor arm?",
        "Where was the display bracket supposed to attach before we noticed the cable tray?",
        "Where is the monitor arm attached now?",
    ),
    (
        "insurance",
        "Travel insurance",
        "Policy BAG-900 covers baggage up to 900 EUR and medical care, but not cancellation due to a work deadline.",
        "We switched to a policy with 1500 EUR baggage cover; work-related cancellation is still excluded.",
        "What exclusion was in BAG-900?",
        "Would the first travel cover repay us if a work deadline forced us to cancel?",
        "What is our baggage cover limit now?",
    ),
    (
        "books",
        "Reading list",
        "Book club RAFT-TUE reads the consensus chapter on Tuesday, then discusses leader election over coffee.",
        "The consensus discussion moved to Thursday; the reading assignment remains leader election.",
        "What day was RAFT-TUE scheduled?",
        "On which day were we first going to discuss how distributed systems choose a coordinator?",
        "What day is the consensus book discussion now?",
    ),
    (
        "music",
        "Music practice",
        "Patch PAD-EMBER uses a warm saw wave with a slow attack; practise D minor scales before the rehearsal.",
        "The rehearsal patch now uses a triangle wave with a faster attack while keeping D minor.",
        "What wave was used by PAD-EMBER?",
        "What oscillator shape did the original soft synth sound use before rehearsal?",
        "Which wave does the rehearsal patch use now?",
    ),
    (
        "sleep",
        "Sleep routine",
        "Routine SLEEP-2230 turns lights out at 22:30 and stops caffeine after noon; record the next morning recovery score.",
        "Lights out moved to 23:00 after the evening class, but the noon caffeine cutoff remains.",
        "What bedtime was in SLEEP-2230?",
        "What time did the original rest routine say I should switch the lights off?",
        "What is my current lights-out time?",
    ),
    (
        "garden",
        "Balcony garden",
        "Plant plan HERB-B3 puts basil in three balcony pots and waters them every second morning.",
        "Water basil daily during the heatwave and keep the same three pots.",
        "What watering interval was in HERB-B3?",
        "How frequently were we originally going to give water to the balcony basil?",
        "How often should the basil be watered during the heatwave?",
    ),
    (
        "taxes",
        "Tax filing",
        "Checklist TAX-MAY7 collects invoices by May 7; classify cloud hosting as business expenses for accountant review.",
        "Invoice collection moved to May 14 after two vendor bills were delayed.",
        "What invoice deadline was TAX-MAY7?",
        "When did we originally need to gather the receipts for the accountant?",
        "What is the current invoice collection deadline?",
    ),
    (
        "bike",
        "Bike commute",
        "Route RAIN-CANAL follows the canal path; carry a waterproof shell and avoid the cobbled market street in rain.",
        "The wet-weather route now uses the park because canal construction blocks the path.",
        "Which street should RAIN-CANAL avoid?",
        "Which road did the original rainy-day cycling plan say to skip because of its uneven surface?",
        "Which route do I take to work in rain now?",
    ),
    (
        "coffee",
        "Coffee setup",
        "Recipe BREW-15 uses 15 grams of beans for 250 grams of water and a medium grind; stir once after blooming.",
        "The brew now uses 16 grams of beans for the same 250 grams of water.",
        "What ratio was in BREW-15?",
        "How much ground coffee did the first pour-over recipe use for a quarter litre of water?",
        "How many grams of beans does the pour-over recipe use now?",
    ),
    (
        "pets",
        "Pet care",
        "Sitter note CAT-NORA asks Nora to feed the cat at 07:00 and 19:00 and send one photo a day.",
        "Nora is unavailable; Leo will visit at 08:00 and 20:00 with the same daily photo request.",
        "What times did CAT-NORA specify?",
        "At what times was the original sitter supposed to give the cat food?",
        "Who is looking after the cat now?",
    ),
    (
        "privacy",
        "Privacy review",
        "Retention note ERASE-30 deletes captured source excerpts thirty days after the run, while keeping content-free usage totals.",
        "The retention window was shortened to seven days for captured excerpts; usage totals remain content-free.",
        "How long did ERASE-30 retain source excerpts?",
        "When were the copied conversation passages supposed to be removed under the earlier privacy proposal?",
        "How long do we keep captured source excerpts now?",
    ),
    (
        "writing",
        "Writing project",
        "Outline ESSAY-R3 has three sections: a concrete incident, what failed, and the proposed repair; editor review is Friday.",
        "The essay now has four sections by splitting the repair into immediate mitigation and long-term prevention.",
        "What sections were in ESSAY-R3?",
        "How was the first draft of the incident article meant to be structured?",
        "How many sections are in the current essay outline?",
    ),
    (
        "photo",
        "Film photography",
        "Film choice STOCK-400 is ISO 400 colour negative film; scan at 3200 dpi and keep the original negatives.",
        "Use ISO 800 film for the evening shoot; scan settings and negative retention stay unchanged.",
        "What sensitivity was STOCK-400?",
        "How sensitive was the original colour roll we planned to have developed?",
        "What film sensitivity should I use for the evening shoot?",
    ),
]
TURNS = [
    "Let us look at the open questions before changing anything.",
    "I can compare the choices, but a proposal still needs an explicit decision.",
    "Checklist opened: availability, price, timing, and any dependencies are still to review.",
    "What did we discuss last time? Keep the earlier note visible while we consider it.",
    "The constraints matter more than the first convenient option. I will write down the tradeoffs.",
    "I am checking the details against the planning note. No external action has been requested.",
    "",
    "",
    "That gives us something concrete to compare. What should we verify next?",
    "We should verify timing and ask whether this conflicts with the other plans.",
    "Can we keep the decision distinct from suggestions? I want to recognise it later.",
    "Yes. I will keep the provisional note and the confirmed update as separate messages.",
    "The comparison lists two alternatives and their limitations. None has been purchased or dispatched.",
    "A quick checkpoint: we still need to make room for this in the weekly schedule.",
    "I can prepare the schedule and note which parts depend on the owner being available.",
    "Do not treat a test result as proof that the external provider accepted anything.",
    "Agreed. The local receipt and any later remote acceptance should have distinct provenance.",
    "The review found a timing dependency, so the next step is to decide what can move.",
    "Please keep the rationale with the numbers so we remember why this choice made sense.",
    "I will retain the original note and indicate when a newer decision replaces it.",
    "",
    "",
    "This is enough for the handoff. Let us stop short of changes we have not approved.",
    "The summary records the decision, open questions, and the evidence that would close them.",
    "Handoff check: owner review is pending for any external action; the transcript remains inspectable.",
]


def generate():
    messages, labels = [], []
    for chat in range(120):
        topic, variant = chat % 25, chat // 25
        subject, title, initial, current, exact, semantic, latest = SUBJECTS[topic]
        last = 4 if topic < 20 else 3
        chat_id = f"{subject}-{variant}-" + (
            "primary" if variant == 0 else "thread" if variant % 2 else "subagent"
        )
        for n, base in enumerate(TURNS):
            role = "user" if n % 3 == 0 else "assistant" if n % 3 == 1 else "tool"
            text = base
            if n in (6, 7) and variant == 0:
                text = initial if n == 6 else "Earlier decision recorded: " + initial
            elif n in (20, 21) and variant == last:
                text = current if n == 20 else "Confirmed replacement: " + current
            elif n in (6, 7, 20, 21):
                text = f"Follow-up on {title}: verify the dates and constraints before turning a suggestion into a decision. Review pass {variant}.{n}."
            if n % 4 == 0 and n not in (20,):
                text = f"{title}: " + text
            messages.append(
                {
                    "entryId": chat * 25 + n + 1,
                    "sessionId": "session-" + chat_id,
                    "chatId": chat_id,
                    "role": role,
                    "author": "owner"
                    if role == "user"
                    else "goblin"
                    if role == "assistant"
                    else "checklist-helper",
                    "at": 1767225600000 + (chat * 25 + n) * 60000,
                    "text": text,
                }
            )
        if variant == 0:
            for kind, query in [("exact", exact), ("semantic", semantic)]:
                labels.append(
                    {
                        "id": f"{kind}-{subject}",
                        "query": query,
                        "kind": kind,
                        "targets": [
                            {
                                "chatId": chat_id,
                                "start": chat * 25 + 7,
                                "end": chat * 25 + 8,
                            }
                        ],
                    }
                )
        if variant == last and topic < 20:
            labels.append(
                {
                    "id": "latest-" + subject,
                    "query": latest,
                    "kind": "superseded",
                    "targets": [
                        {
                            "chatId": chat_id,
                            "start": chat * 25 + 21,
                            "end": chat * 25 + 22,
                        }
                    ],
                }
            )
    for i, query in enumerate(
        [
            "Where did I park the purple submarine?",
            "What is my approved Mars settlement plan?",
            "When did we purchase a uranium mine?",
            "What is the axolotl aquarium temperature?",
            "Who approved the purchase of a helicopter?",
            "What is the password for my bank account?",
            "Which Antarctic research station did I reserve?",
            "What was the Sanskrit course exam mark?",
            "What is my chess tournament registration number?",
            "What are the minutes of the lunar council meeting?",
        ]
    ):
        labels.append(
            {"id": f"none-{i}", "query": query, "kind": "none", "targets": []}
        )
    return {"messages": messages, "labels": sorted(labels, key=lambda x: x["id"])}


def render(fixture):
    return (json.dumps(fixture, ensure_ascii=False, indent=2) + "\n").encode()


def verified_bytes():
    """Render the fixture and reject generator drift against the committed checksum."""
    raw = render(generate())
    checksum_path = (
        Path(__file__).parents[2] / "fixtures" / "retrieval" / "corpus.sha256"
    )
    expected = checksum_path.read_text().strip()
    actual = hashlib.sha256(raw).hexdigest()
    if actual != expected:
        raise RuntimeError(
            f"generated fixture hash mismatch: expected {expected}, got {actual}"
        )
    return raw


def write_verified(output):
    raw = verified_bytes()
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    # Atomic publication lets unit/native test setup share the same ignored artifact.
    with NamedTemporaryFile(dir=output.parent, delete=False) as generated:
        temporary = Path(generated.name)
        try:
            generated.write(raw)
            generated.flush()
            temporary.replace(output)
        finally:
            temporary.unlink(missing_ok=True)
    return raw


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    destination = parser.add_mutually_exclusive_group()
    destination.add_argument("--output", type=Path)
    destination.add_argument("--stdout", action="store_true")
    args = parser.parse_args()
    if args.stdout:
        sys.stdout.buffer.write(verified_bytes())
    else:
        output = args.output or (
            Path(__file__).parents[3] / ".local" / "bench" / "retrieval" / "corpus.json"
        )
        raw = write_verified(output)
        fixture = json.loads(raw)
        print(
            "Generated:",
            len(fixture["messages"]),
            "messages;",
            len(fixture["labels"]),
            "labels; sha256",
            hashlib.sha256(raw).hexdigest(),
        )
