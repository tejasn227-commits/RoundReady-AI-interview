*Engineering Insights • Agent Memory & Architecture*

# Building RoundReady: Persistent Interview Memory That Turns Feedback Into a Plan

Connecting multi-round candidate experiences into structured, company-specific preparation workflows using persistent agent memory.

A useful interview coach should remember more than the last answer. It should connect what happened in one interview to what the candidate needs to do next—and still know the difference between a transcript, a personal preference, and a commitment with a deadline.

That distinction became the central design problem in RoundReady. I built it as a Flask application that captures interview conversations, extracts structured feedback, stores useful context in Hindsight, and uses that context to generate a company- and role-specific preparation roadmap.

## From Conversation to Next Step

RoundReady supports several ways to bring an interview into the system: a pasted transcript, an uploaded audio recording, or audio captured from a shared browser tab. In the live flow, the browser sends completed audio chunks to the server for transcription. The user can also review and save a conversation rather than treating the live stream as a permanent record by default.

After transcription, the backend asks a language model to extract a structured set of observations: questions and answers, weak points, quality scores, interviewer style, explicit promises, and next steps. The point of that structure is not to turn every response into a score. The extraction prompt tells the model not to invent missing details, and to leave scores empty when there is not enough evidence.

Once extracted, those notes feed several parts of the application. The candidate can review saved conversations, inspect recurring patterns, compare answers over time, track open commitments, and request a roadmap for an upcoming interview. Company research is added to the roadmap so that preparation is informed by both the candidate’s history and external material.

The application uses Flask for its HTTP endpoints, a browser interface built with HTML, CSS, and JavaScript, Groq for structured language-model work and transcription, Tavily for web research, Resend for email, and APScheduler for recurring background jobs. Hindsight is the persistence and retrieval layer that ties interview sessions together.

## Why I Treated Memory as a Product Feature

The easiest version of an AI interview coach is also the least useful: send the current transcript to a model and ask for advice. That can produce plausible feedback, but each session starts over. It cannot reliably connect a recurring weakness to a later answer, remember what the candidate said they would do, or tailor a new plan to a particular company.

I wanted RoundReady to work across sessions. That meant treating memory not as one large chat history, but as information that has different shapes and different useful lifetimes.

**RoundReady AI — Persistent Interview Memory**  
*Page 1 of 5*

A raw interview transcript is valuable for review, but it is long and may contain details that are irrelevant after a while. A structured summary is smaller and easier to use in future planning. A commitment such as “send the portfolio by Friday” has a different purpose again: it needs a status and a due date, not just a place in a paragraph.

RoundReady writes interview content and extracted metadata to Hindsight with stable document identifiers and tags. The metadata captures context such as company, round, source, role, and interview ID. Promises and next steps are stored as separate records, which makes it possible to list and update them independently. This is the integration point with Hindsight’s GitHub project: the application can retain experiences and retrieve relevant context later, rather than rebuilding the entire past from a prompt.

```python
def _retain(
    content: str,
    metadata: dict[str, str],
    *,
    document_id: str | None = None,
    update_mode: str | None = None,
    tags: list[str] | None = None,
) -> None:
    _service_call(
        "Hindsight",
        lambda: _hindsight().retain(
            bank_id=BANK_ID,
            content=content,
            metadata=metadata,
            document_id=document_id,
            update_mode=update_mode,
            tags=tags,
        ),
    )
```

The wrapper is intentionally small. It centralizes the bank choice and routes the operation through the application’s service-error handling. More importantly, it makes the calling code state its intent: provide content, attach metadata, choose an identifier, and optionally tag the record.

The interview store then creates one record that carries both a human-readable summary and the structured analysis:

**RoundReady AI — Persistent Interview Memory**  
*Page 2 of 5*

```python
content = (
    f"Interview at {company or 'an unspecified company'}, "
    f"round {round_number or 'unspecified'}.\n"
    f"Summary: {notes['summary']}\n"
    f"Interviewer style: {notes['interviewer_style']}\n"
    f"Structured notes: {json.dumps(notes, ensure_ascii=False)}\n"
    f"Transcript: {transcript}"
)
_retain(
    content,
    metadata,
    document_id=metadata["interview_id"],
    update_mode="append" if source == "live_audio_chunk" else "replace",
    tags=["interview", f"company:{(company or 'unspecified').strip().casefold()}"],
)
```

The stable ID matters for updates: live chunks belonging to the same interview can be appended to the corresponding record, while a completed text or audio submission replaces the record for that interview. The separate metadata also lets the application reason about an interview without trying to parse every fact back out of free-form text.

## Retrieval Should Be Relevant, Not Merely Available

Persisting data is only half of memory. A roadmap for a specific company should not blindly include every saved interview. RoundReady forms a query around the target company and interview outcomes, adds a company tag filter, and checks the metadata again before accepting a result.

**RoundReady AI — Persistent Interview Memory**  
*Page 3 of 5*

```python
recall_query = (
    f"Interview transcript, answers, weaknesses, technical questions, and outcomes for "
    f"{company} across every candidate interview and round"
)
for record in _recall(
    recall_query,
    max_tokens=5000,
    tags=[f"company:{company.strip().casefold()}"],
):
    metadata = _record_metadata(record)
    if str(metadata.get("company", "")).casefold() != company.casefold():
        continue
    memories.append(record)
```

That second check is deliberate. Search relevance is useful, but the application also has a specific boundary: a company-specific roadmap should be based on records for that company. The result is a combination of semantic retrieval and explicit application-level filtering—not an assumption that similarity alone is a sufficient access or relevance rule.

This is where Hindsight’s role becomes more than “somewhere to put the transcript.” RoundReady uses it to retrieve memories that can shape a future response. The broader idea of agent memory and persistent context is practical here: without a way to recall relevant past experiences, an AI workflow is stateless; with it, the system can build on what the candidate has already done.

The implementation also has a fallback when semantic recall is unavailable: it can try loading saved documents and report a warning rather than quietly presenting a normal-looking personalized roadmap with no memory behind it. That is an important product distinction. A fallback can improve resilience, but the user should be able to tell when personalization is incomplete.

## A Roadmap is a Synthesis, Not a Calendar Template

When a candidate asks for a plan, they provide a company, a role, and the number of days remaining. RoundReady can then bring together several evidence sources: recalled company-specific memories, saved conversation summaries, open promises, broader interview patterns, answer-progress records, improvement areas, and web research.

That is a richer prompt than “make me a five-day interview plan.” It gives the model a reason to prioritize. If past interviews show that the candidate’s technical answers lack clear structure, and a current commitment is to practice explaining trade-offs, the roadmap can make those items more prominent than generic preparation advice. The target role and time available constrain the plan; company research contributes current external context.

The roadmap endpoint also reports what it used: recalled memory, saved conversations, promises, patterns, progress records, and web sources. I like this kind of accounting because it gives the interface a way to distinguish a grounded plan from one generated with little personal history. It also makes failures visible. When memory retrieval or another upstream service is unavailable, the application can return warnings alongside the result.

The resulting interaction is concrete. A candidate logs an interview, RoundReady transcribes and analyzes it, and the candidate later asks for a plan for a second round at the same company. The next plan can draw on the earlier questions, observed improvement areas, and commitments that remain open. After the candidate completes a task, that commitment can be marked complete rather than resurfacing indefinitely as stale advice.

## Memory Needs Maintenance

Keeping everything forever is not automatically a good memory strategy. RoundReady includes a cleanup path that replaces older raw dialogue with a structured summary in the same Hindsight file after a retention period. The interface describes that history behavior as seven days. The goal is to preserve useful lessons while reducing the need to keep the full conversational detail indefinitely.

Promises are handled separately because their lifecycle differs from transcripts. A due date can trigger reminders, and background jobs periodically check which reminders need sending. A promise has a status and reminder markers; it can be completed without rewriting the underlying interview history. This separation is what allows memory to support follow-through rather than just recall.

**RoundReady AI — Persistent Interview Memory**  
*Page 4 of 5*

I also made memory optional in the interface. Turning it off changes whether RoundReady includes remembered context in a roadmap. That control matters because personalization has a cost: it requires the application to retain and use personal interview material. A useful memory feature should be explicit and explain what it changes, rather than treating retention as invisible plumbing.

For implementation details, the Hindsight documentation is the place to understand the client and memory operations used by this integration.

## Lessons I Would Carry Into Another System

- Model the things users need to act on separately. A transcript, a lesson, and a deadline may come from the same conversation, but they should not share one lifecycle. Structured records make retrieval and reminders much easier to reason about.
- Treat retrieval as a product decision. A semantically relevant result is not necessarily relevant to this user’s current task. Combine natural-language recall with metadata, tags, and explicit checks for the context the request requires.
- Do not let fallback behavior impersonate success. If memory is missing, a generic plan may still be useful, but it is not personalized. Return warnings and provenance so the interface can say what actually informed the result.
- Make extraction conservative. Interview feedback can affect someone’s confidence and preparation. The system should distinguish observed evidence from inference, avoid inventing commitments or scores, and be clear when the transcript does not support a conclusion.
- Give memory an expiration and a purpose. Retention should preserve what helps future decisions, not simply accumulate data. Summaries, structured outcomes, and separately tracked commitments are more useful over time than an ever-growing transcript archive.

RoundReady’s most important engineering choice was not which model to call. It was deciding what the application should remember, how it should retrieve that information, and how to show the user when that memory influenced a result. That is what turns a one-off interview analysis into a tool that can help someone prepare, reflect, and follow through across the whole process.

**RoundReady AI — Persistent Interview Memory**  
*Page 5 of 5*
