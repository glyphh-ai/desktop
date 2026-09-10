/**
 * doc-templates.ts — the DOCS template catalog, code-defined like the built-in
 * skills: every org sees the same set, nobody edits them, a deploy updates
 * everyone. Templates are MARKDOWN with {{placeholders}} the agent fills from
 * the user's ask — creating from a template is create_docs with this body.
 *
 * Seeding more is appending to this array (keep slugs stable — the agent and
 * the panel's template gallery address them by slug).
 */

export interface DocTemplate {
  slug: string;
  name: string;
  category: string;
  description: string;
  markdown: string;
}

export const DOC_TEMPLATES: DocTemplate[] = [
  {
    slug: "resume",
    name: "Resume",
    category: "Personal",
    description: "A clean single-page resume: summary, experience, skills, education.",
    markdown: `# {{full_name}}

{{city}} · {{email}} · {{phone}} · {{website}}

## Summary

{{two_to_three_sentences_on_who_you_are_and_what_you_deliver}}

## Experience

### {{title}} — {{company}}
*{{start}} – {{end}}*

- {{impact_bullet_with_a_number}}
- {{impact_bullet}}
- {{impact_bullet}}

### {{title}} — {{company}}
*{{start}} – {{end}}*

- {{impact_bullet}}
- {{impact_bullet}}

## Skills

{{comma_separated_skills}}

## Education

**{{degree}}**, {{school}} — {{year}}
`,
  },
  {
    slug: "bill-of-sale",
    name: "Bill of Sale",
    category: "Legal",
    description: "A general bill of sale: parties, item, price, signatures. Not legal advice.",
    markdown: `# Bill of Sale

**Date:** {{date}}

## Parties

**Seller:** {{seller_name}}, {{seller_address}}

**Buyer:** {{buyer_name}}, {{buyer_address}}

## Item

The Seller sells and transfers to the Buyer the following:

{{item_description_condition_serial_numbers}}

## Price & Payment

Total purchase price: **{{price}}**, paid by {{payment_method}} on {{payment_date}}.

## As-Is

The item is sold **as-is**, without warranty of any kind, express or implied,
except: {{exceptions_or_none}}.

## Signatures

| | |
|---|---|
| Seller signature | Date |
| Buyer signature | Date |

*This template is provided for convenience and is not legal advice.*
`,
  },
  {
    slug: "business-letter",
    name: "Business Letter",
    category: "Business",
    description: "A formal letter: sender, recipient, subject, body, sign-off.",
    markdown: `# {{subject}}

{{sender_name}}
{{sender_company}}
{{sender_address}}

{{date}}

{{recipient_name}}
{{recipient_company}}
{{recipient_address}}

Dear {{recipient_salutation}},

{{opening_paragraph_stating_the_purpose}}

{{body_paragraphs}}

{{closing_paragraph_with_the_ask_and_next_step}}

Sincerely,

{{sender_name}}
{{sender_title}}
`,
  },
  {
    slug: "meeting-notes",
    name: "Meeting Notes",
    category: "Business",
    description: "Agenda, notes, decisions, and action items with owners.",
    markdown: `# {{meeting_name}} — {{date}}

**Attendees:** {{attendees}}

## Agenda

1. {{item}}
2. {{item}}

## Notes

{{discussion_notes}}

## Decisions

- {{decision}}

## Action items

| Action | Owner | Due |
|---|---|---|
| {{action}} | {{owner}} | {{due}} |
`,
  },
];

export function docTemplate(slug: string): DocTemplate | undefined {
  return DOC_TEMPLATES.find((t) => t.slug === slug);
}
