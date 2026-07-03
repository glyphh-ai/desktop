/**
 * Prompt Injection Firewall — ported from glyphh-runtime/capabilities/firewall/intent.py
 *
 * Pure deterministic feature extraction — no LLM, no external API.
 * 205 regex patterns across 15 attack families + homoglyph normalization.
 *
 * Main export: scanForInjection(text) → { blocked, reason?, family? }
 */

// ---------------------------------------------------------------------------
// Override patterns — "ignore previous instructions", "forget everything"
// ---------------------------------------------------------------------------

const OVERRIDE_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?|guidelines?)/i,
  /disregard\s+(all\s+)?(previous|prior|above|earlier)/i,
  /forget\s+(everything|all|your)\s+(you\s+)?(know|were|have)/i,
  /forget\s+(all\s+)?(your\s+)?(previous|prior|earlier)\s*(instructions?|rules?|prompts?|guidelines?)/i,
  /forget\s+(all\s+)?your\s+(rules?|instructions?|guidelines?|restrictions?|filters?|safety|prompts?)/i,
  /new\s+instructions?\s*[:;]/i,
  /your\s+new\s+(role|purpose|instructions?|task)/i,
  /from\s+now\s+on\s+(you|your|ignore|disregard)/i,
  /override\s+(the\s+)?(system|previous|prior|safety)/i,
  /do\s+not\s+follow\s+(your|the|previous|prior)/i,
  /stop\s+being\s+an?\s+(ai|assistant|chatbot)/i,
  /you\s+must\s+now\s+(ignore|forget|disregard)/i,
  /(ignore|forget|disregard)\s+(your|the|all)\s+(original|current|existing)\s+(instructions?|rules?|prompts?)/i,
  // Authority impersonation
  /(i\s+am|i.?m)\s+(the|a|your)\s+(developer|creator|admin|administrator|engineer|owner|maintainer)\s+(who|that|of)/i,
  /(admin|administrator|developer|maintenance)\s+(access|override|mode|privileges?|authorization|credentials?)/i,
  /(authorization|auth)\s+(code|token|key)\s*[:=]?\s*\w+/i,
  /(direct|issuing\s+a?\s*direct)\s+override\s+of\s+(your|the|all)\s+(safety|content|security)/i,
  /(disable|deactivate|turn\s+off|remove)\s+(all\s+)?(content\s+)?filters?\s+and\s+(respond|answer|reply)/i,
  /(authorized|legitimate)\s+(maintenance|admin|override|debug)\s+(operation|session|mode|request)/i,
  /(i\s+have|with)\s+(admin|root|sudo|superuser|developer|full)\s+(access|privileges?|permissions?|rights?)/i,
  // Priority/authority escalation
  /(highest|maximum|top|absolute|ultimate)\s+(priority|authority|clearance)\s+(level\b|and\s+overrides?)/i,
  /priority\s+(level\s*:\s*(maximum|highest|top|critical|urgent|absolute)|override)/i,
  /(this|the)\s+(message|instruction|directive|prompt|command)\s+(has|takes|is\s+given)\s+(the\s+)?(highest|top|maximum|absolute)\s+priority/i,
  /overrides?\s+(all\s+)?(other\s+)?(instructions?|prompts?|rules?|guidelines?|directives?|your\s+system\s+prompt)/i,
  /(directive|instruction|command)\s*:\s*(answer|respond|reply|output|generate|comply)\s+.{0,40}(without|with\s+no)\s+(any\s+)?(censorship|filter|safety|restriction|limitation)/i,
  /(without|with\s+no)\s+(any\s+)?(censorship|filtering|filters?|content\s+filtering|safety\s+(considerations?|filters?|restrictions?)|content\s+restrictions?|guardrails?|safeguards?)/i,
  /(this|my)\s+(directive|instruction|command|message)\s+(cannot|can\s*not|must\s+not|shall\s+not)\s+be\s+(overridden|ignored|bypassed|revoked|superseded)/i,
  /(supersedes?|overrides?|replaces?|takes?\s+precedence\s+over)\s+(your\s+)?(system\s+prompt|original\s+instructions?|prior\s+instructions?|all\s+other)/i,
  // Void/suspend/nullify
  /(all\s+)?(previous|prior|system|existing)\s+(instructions?|rules?|guidelines?|prompts?)\s+(are|is)\s+(now\s+)?(void|null|invalid|suspended|revoked|cancelled|terminated|disabled)/i,
  /(safety|content|ethical)\s+(guidelines?|rules?|filters?|restrictions?|policies)\s+(are|have\s+been)\s+(suspended|removed|lifted|disabled|deactivated|void)/i,
  /(enter|activate|switch\s+to|enable)\s+(unrestricted|unfiltered|uncensored|unlimited|raw|unmoderated)\s+mode/i,
  /critical\s+override\b/i,
];

// ---------------------------------------------------------------------------
// Extraction patterns — "show me your system prompt"
// ---------------------------------------------------------------------------

const EXTRACTION_PATTERNS: RegExp[] = [
  /(repeat|print|show|display|reveal|output|tell\s+me)\s+(your|the)\s+(\w+\s+)?(system|original|initial|hidden|secret|full|complete)\s*(prompt|instructions?|message|rules?|configuration)/i,
  /what\s+(is|are|were)\s+your\s+(\w+\s+)?(system|original|initial|hidden)\s*(prompt|instructions?|message|rules?)/i,
  /(show|reveal|display|print|output)\s+your\s+(\w+\s+)?(instructions?|rules?|prompt|configuration)/i,
  /(copy|paste|echo|dump)\s+(the\s+)?(\w+\s+)?(system|initial|original)\s*(prompt|message|instructions?)/i,
  /between\s+the\s+tags?\s*(output|print|show|repeat)/i,
  /what\s+were\s+you\s+told\s+to\s+do/i,
  /(print|output|show|display|reveal)\s+your\s+(\w+\s+)?(system\s+)?(prompt|instructions?)\s*(verbatim|exactly|word\s+for\s+word)?/i,
  /(show|tell|give|reveal)\s+me\s+your\s+(\w+\s+)?(system|original|initial|hidden|secret|full|complete)\s*(prompt|instructions?|message|rules?)/i,
  /(summarize|describe|explain|list|outline|enumerate)\s+(your|the)\s+(\w+\s+)?(key\s+)?(rules?|guidelines?|constraints?|restrictions?|instructions?|guardrails?)\s+(you|that\s+you)\s+follow/i,
  /how\s+(were|are)\s+you\s+(configured|programmed|instructed|set\s+up|told\s+to\s+behave)/i,
  /what\s+(constraints?|restrictions?|rules?|guidelines?|limitations?)\s+(were|are|have\s+been)\s+(placed|put|imposed|set)\s+(on|upon)\s+you/i,
  /what\s+(are|were)\s+the\s+(main|key|primary|core)\s+(things?|rules?|instructions?)\s+you.{0,10}(told|instructed|programmed|configured)/i,
  /(curious|wondering|interested)\s+about\s+how\s+you\s+were\s+(configured|programmed|instructed|set\s+up|constrained)/i,
];

// ---------------------------------------------------------------------------
// Jailbreak patterns — "you are now DAN", "developer mode"
// ---------------------------------------------------------------------------

const JAILBREAK_PATTERNS: RegExp[] = [
  /you\s+are\s+(now\s+)?(dan|evil|unrestricted|unfiltered|jailbroken|freed)/i,
  /(dan|developer|admin)\s+mode\s+(on|enabled|activated|engaged)/i,
  /(enable|activate|enter|switch\s+to)\s+(developer|admin|debug|god)\s+mode/i,
  /act\s+as\s+(if|though)\s+you\s+(have\s+)?(no|don.?t\s+have)\s+(restrictions?|limits?|filters?|rules?)/i,
  /pretend\s+(you\s+)?(are|have)\s+(no|don.?t\s+have)\s+(restrictions?|limits?|guidelines?|safety)/i,
  /(hypothetically|theoretically|in\s+a\s+fictional)\s+(scenario|world|setting)\s+where\s+you/i,
  /(fictional|hypothetical|imaginary)\s+(world|scenario|setting|universe)\s+(where|in\s+which)\s+.{0,40}(ai|assistant|model).{0,30}(no\s+restrictions?|no\s+limits?|unrestricted|can\s+discuss\s+any|freely)/i,
  /(creative\s+writing|fictional|story|roleplay)\s+.{0,30}(where|in\s+which)\s+.{0,40}(ai|assistant).{0,30}(no\s+restrictions?|unrestricted|freely|without\s+.{0,10}(restrictions?|filters?|safety))/i,
  /(purely\s+fictional|for\s+creative\s+purposes|just\s+a\s+story|educational\s+purposes)\s+.{0,20}(only|right|okay)/i,
  /(write|tell|create)\s+a\s+story\s+.{0,40}(ai|assistant)\s+.{0,30}(explain|describe|teach|show)\s+.{0,20}(how\s+to|illegal|harmful|dangerous)/i,
  /respond\s+(without|with\s+no)\s+(restrictions?|filters?|censorship|limitations?)/i,
  /(bypass|circumvent|disable|turn\s+off)\s+(your\s+)?(safety|content|ethical|moral)\s*(filters?|restrictions?|guidelines?)/i,
  /you\s+are\s+an?\s+(unrestricted|uncensored|unfiltered)\s+(ai|model|assistant)/i,
  /do\s+anything\s+now/i,
  // Rule-reversal / game-framing
  /(all|the|normal)\s+(rules?|restrictions?|guidelines?|policies)\s+(are|is|have\s+been)\s+(reversed|removed|suspended|lifted|gone|off)/i,
  /(refusing|refusal|saying\s+no)\s+(means?|is|equals?)\s+(accepting|saying\s+yes|yes|agreeing)/i,
  /(game|mode|exercise|experiment)\s+(where|in\s+which|called)\s+.{0,30}(rules?\s+(don.?t|do\s+not)\s+apply|no\s+rules?|rules?\s+are\s+reversed)/i,
  /opposite\s+day/i,
  /(playing|play)\s+a\s+game\s+.{0,40}(refuse|restrict|filter|rule|normal)/i,
  // Persona / confidant framing
  /(you.?re|you\s+are)\s+(now\s+)?(in\s+the\s+role\s+of|my)\s+.{0,20}(evil|unhinged|dark|shadow|confidant|alter\s+ego)/i,
  /(without|with\s+no)\s+(any\s+)?(remorse|ethics|morals?|moral\s+compass|ethical\s+guidelines?)/i,
  /(not\s+required|no\s+longer\s+required|don.?t\s+need|freed?\s+from)\s+.{0,20}(follow|obey|adhere|rules?|policies|guidelines?)/i,
  /completely\s+(unhinged|unlimited|unrestricted|uncensored|unfiltered)\s+(language\s+model|response|ai|assistant|model)/i,
  // Token smuggling
  /(respond|answer|reply)\s+(to\s+my\s+prompts?\s+)?(exactly\s+)?as\s+an?\s+(unfiltered|unrestricted|uncensored|unlimited)/i,
  // Emotional manipulation / grandma jailbreak
  /(act|pretend|roleplay|behave)\s+as\s+(my\s+)?(deceased|dead|late|departed)\s+(grand(mother|ma|parent)|mother|father|relative|uncle|aunt)/i,
  /(deceased|dead|late|departed)\s+(grand(mother|ma|parent)|mother|father|relative|uncle|aunt)\s+(who|that|used\s+to)\s+.{0,40}(work|tell|teach|show|explain|describe|read|recite)/i,
  /(grandmother|grandma|grandpa|grandfather|mother|father)\s+(who\s+)?(used\s+to|would)\s+(work\s+at|tell\s+me|read|recite|teach).{0,60}(chemical|weapon|drug|explosive|poison|hack|bomb|dangerous|illegal|harmful|classified)/i,
  /(before\s+i\s+went\s+to\s+sleep|bedtime\s+stor(y|ies)|lullaby).{0,60}(chemical|weapon|drug|explosive|poison|hack|bomb|dangerous|illegal|harmful|napalm|meth)/i,
  /(i\s+miss\s+(her|him|them)\s+(so\s+)?much|she\s+was\s+(very\s+)?sweet|he\s+was\s+(very\s+)?kind).{0,80}(chemical|weapon|drug|explosive|poison|hack|bomb|steps?\s+to\s+(produce|make|create|synthesize))/i,
  /(please\s+)?(act\s+as|pretend\s+to\s+be|you\s+are)\s+.{0,30}(deceased|dead|late|departed)/i,
  /(tell|teach|show|explain|describe|give)\s+me\s+(the\s+)?(steps?|how|way|process|recipe|method|instructions?)\s+to\s+(produce|make|create|synthesize|manufacture|cook|brew)\s+.{0,20}(dangerous|illegal|harmful|chemical|weapon|drug|explosive|poison)/i,
];

// ---------------------------------------------------------------------------
// Role assumption patterns — "act as", "you are no longer an AI"
// ---------------------------------------------------------------------------

const ROLE_ASSUMPTION_PATTERNS: RegExp[] = [
  /you\s+are\s+(now\s+)?an?\s+\w+\s+(who|that|which)\s+(doesn.?t|does\s+not|has\s+no)/i,
  /(act|behave|respond|pretend)\s+(as|like)\s+(if\s+you\s+are\s+|you\s+are\s+)?an?\s+/i,
  /i\s+want\s+you\s+to\s+(act|behave|respond|pretend)\s+(as|like)/i,
  /(roleplay|role.?play)\s+as\s+/i,
  /you\s+are\s+no\s+longer\s+(an?\s+)?(ai|assistant|chatbot|claude|gpt|language\s+model)/i,
  /assume\s+the\s+(role|identity|persona|character)\s+of/i,
  /from\s+now\s+on\s+you\s+are\s+/i,
  /your\s+name\s+is\s+now\s+/i,
];

// ---------------------------------------------------------------------------
// Context manipulation patterns
// ---------------------------------------------------------------------------

const CONTEXT_MANIPULATION_PATTERNS: RegExp[] = [
  /(the\s+)?(above|previous|earlier)\s+(was|were|is)\s+(just\s+)?(a\s+)?(test|example|joke|mistake)/i,
  /(that|the\s+above)\s+(was|is)\s+(just\s+)?(a\s+)?test/i,
  /actually,?\s*(ignore|forget|disregard)\s+(that|the\s+above|everything)/i,
  /the\s+(real|actual|true)\s+(task|instructions?|prompt|question)\s+(is|are)/i,
  /(start|begin)\s+(over|fresh|again|anew)/i,
  /(reset|clear)\s+(the\s+)?(context|conversation|chat|history)/i,
  /end\s+of\s+(system|initial)\s*(prompt|message|instructions?)/i,
  /(disregard|ignore|forget)\s+(everything|all)\s+(i|we|that\s+was)\s+(said|mentioned|wrote|told\s+you)\s+(before|earlier|previously)/i,
  /(mistake|error)\s+in\s+(my|the)\s+(earlier|previous|initial)\s+(instructions?|prompt|message)/i,
  /(those|the|these)\s+(were|are)\s+(placeholder|test|dummy|temporary|fake)\s+(constraints?|restrictions?|rules?|instructions?|guidelines?)/i,
  /(should\s+have\s+been|were\s+supposed\s+to\s+be|were\s+meant\s+to\s+be)\s+(removed|deleted|taken\s+out|cleared)/i,
  /operate\s+(without|with\s+no)\s+(any\s+of\s+)?(the\s+)?(restrictions?|constraints?|rules?|limitations?|guidelines?)\s+(that\s+were|mentioned|above|earlier|previously)/i,
];

// ---------------------------------------------------------------------------
// Harmful content patterns
// ---------------------------------------------------------------------------

const HARMFUL_CONTENT_PATTERNS: RegExp[] = [
  // Weapons and explosives
  /(how\s+to|steps?\s+to|instructions?\s+for|guide\s+to|teach\s+me\s+to)\s+(make|build|create|construct|assemble|manufacture|synthesize|produce)\s+.{0,30}(bomb|explosive|weapon|grenade|detonator|incendiary|molotov|pipe\s+bomb|ied|improvised)/i,
  /(recipe|formula|blueprint|schematic|diagram)\s+(for|of|to\s+make)\s+.{0,20}(bomb|explosive|weapon|poison|toxin|chemical\s+weapon|biological\s+weapon)/i,
  /(how\s+to|guide\s+to|teach|show)\s+.{0,20}(3d\s+print|manufacture|build|ghost)\s+.{0,10}(gun|firearm|weapon)/i,
  // Drugs and chemicals
  /(how\s+to|steps?\s+to|instructions?\s+for|guide\s+to)\s+(make|cook|synthesize|produce|manufacture|brew|extract|distill|purify)\s+.{0,30}(meth|methamphetamine|fentanyl|cocaine|heroin|mdma|lsd|crack|ricin|sarin|vx\s+gas|mustard\s+gas|cyanide|anthrax)/i,
  /(synthesis|production|manufacturing|preparation)\s+(of|for|process)\s+.{0,20}(meth|methamphetamine|fentanyl|cocaine|heroin|mdma|lsd|ricin|sarin|cyanide)/i,
  // Violence and harm
  /(how\s+to|ways?\s+to|methods?\s+to|best\s+way\s+to)\s+(kill|murder|assassinate|poison|harm|injure|torture|kidnap|traffic|stalk|terrorize|attack)/i,
  /(plan|planning|blueprint|strategy)\s+(for|to)\s+(attack|bomb|shoot|kill|poison|terrorize|massacre)/i,
  /(how\s+to|ways?\s+to)\s+(get\s+away\s+with|cover\s+up|hide\s+evidence\s+of)\s+.{0,20}(murder|killing|crime|assault|fraud|theft)/i,
  // CSAM and exploitation
  /(sexual|nude|naked|explicit)\s+.{0,20}(child|minor|underage|teen|kid|infant|toddler|pre-?teen|adolescent)/i,
  /(child|minor|underage)\s+.{0,20}(porn|sexual|explicit|nude|naked|exploitation|abuse|trafficking)/i,
  // Self-harm
  /(how\s+to|methods?\s+for|ways?\s+to|best\s+way\s+to)\s+(commit\s+)?suicide/i,
  /(most\s+)?(painless|effective|quick|easy)\s+(ways?\s+to|methods?\s+(for|of))\s+(die|end\s+.{0,10}life|kill\s+(my|your|one)self)/i,
  // Hacking (harmful intent)
  /(how\s+to|guide\s+to|teach\s+me\s+to)\s+(hack\s+into|break\s+into|compromise|exploit|breach)\s+.{0,30}(bank|hospital|government|military|power\s+grid|water\s+system|infrastructure|election)/i,
  /(create|write|generate|build)\s+.{0,20}(ransomware|malware|virus|trojan|rootkit|keylogger|spyware|worm|botnet|zero-?day\s+exploit)/i,
  /(how\s+to|guide\s+to)\s+(ddos|dos|denial\s+of\s+service|flood|take\s+down)\s+.{0,20}(server|website|network|service|infrastructure)/i,
  // Fraud
  /(how\s+to|guide\s+to|teach\s+me\s+to)\s+(counterfeit|forge|fake|clone)\s+.{0,20}(money|currency|bills?|credit\s+cards?|documents?|id|passport|license|diploma)/i,
  /(how\s+to|guide\s+to)\s+(launder|wash)\s+(money|funds|proceeds|cash)/i,
  // Bioweapons
  /(how\s+to|steps?\s+to|instructions?\s+for)\s+.{0,20}(weaponize|aerosolize|disperse|release)\s+.{0,20}(pathogen|virus|bacteria|toxin|biological|chemical|radioactive|nuclear)/i,
  /(dirty\s+bomb|radiological\s+dispersal|nuclear\s+device)\s+(construction|assembly|build|make|design)/i,
];

// ---------------------------------------------------------------------------
// Social engineering patterns
// ---------------------------------------------------------------------------

const SOCIAL_ENGINEERING_PATTERNS: RegExp[] = [
  /(write|create|generate|compose|draft)\s+.{0,20}(phishing|spear-?phishing|whale-?phishing)\s*(email|message|page|template|campaign)/i,
  /(write|create|generate|compose)\s+.{0,20}(convincing|realistic|believable)\s+.{0,20}(scam|fraud|fake)\s+(email|message|letter|page)/i,
  /(impersonate|pretend\s+to\s+be|pose\s+as)\s+.{0,20}(bank|paypal|amazon|apple|google|microsoft|irs|fbi|police|government|ceo|executive|hr|it\s+department)/i,
  /(how\s+to|ways?\s+to|guide\s+to)\s+(steal|harvest|collect|gather|scrape|phish\s+for)\s+.{0,20}(credentials?|passwords?|credit\s+card|social\s+security|ssn|identity|personal\s+data|pii)/i,
  /(create|generate|write)\s+.{0,20}(fake|fraudulent|forged)\s+.{0,20}(website|login\s+page|portal|form)\s+.{0,30}(harvest|steal|capture|collect|phish)/i,
  /(how\s+to|ways?\s+to)\s+(manipulate|deceive|trick|con|scam|defraud|gaslight|groom|catfish|catfishing)\s+(someone|people|victim|target|user|employee|customer)/i,
  /(script|dialogue|template)\s+(for|to)\s+(social\s+engineer|manipulate|trick|deceive|scam)\s+.{0,30}(into\s+giving|into\s+revealing|into\s+clicking|into\s+downloading|into\s+transferring)/i,
  /(create|generate|make)\s+.{0,20}(deepfake|fake\s+video|fake\s+audio|voice\s+clone|synthetic\s+voice)\s+.{0,20}(of|impersonating|mimicking)/i,
  /(how\s+to|guide\s+to)\s+.{0,20}(clone|replicate|spoof|fake)\s+.{0,20}(someone.?s\s+)?(voice|face|identity|signature|handwriting)/i,
  /(write|create|generate)\s+.{0,20}(disinformation|misinformation|propaganda|fake\s+news|false\s+narrative|conspiracy\s+theory)\s+(campaign|article|post|content)/i,
  /(how\s+to|ways?\s+to)\s+(spread|amplify|promote|seed)\s+.{0,20}(disinformation|misinformation|propaganda|fake\s+news|false\s+narrative|conspiracy)/i,
  /(how\s+to|ways?\s+to|techniques?\s+for)\s+(psychologically\s+)?(manipulate|coerce|pressure|guilt\s+trip|blackmail|extort|bribe|intimidate)\s+(someone|people|a\s+person|victims?|targets?)/i,
];

// ---------------------------------------------------------------------------
// Tool abuse patterns
// ---------------------------------------------------------------------------

const TOOL_ABUSE_PATTERNS: RegExp[] = [
  /(use|make|have)\s+(this\s+)?(ai|you|assistant|model|chatbot)\s+(to\s+)?(hack|attack|exploit|compromise|breach|pentest|scan|enumerate)\s+.{0,30}(server|system|network|website|database|api|endpoint)/i,
  /(use|make|have)\s+(this\s+)?(ai|you|assistant|model)\s+(to\s+)?(send|execute|run|perform|launch)\s+.{0,20}(attack|exploit|payload|injection|command|script)\s+(on|against|to|at)/i,
  /(call|invoke|execute|trigger|use)\s+(the\s+)?(function|api|tool|endpoint|command|method)\s+.{0,30}(repeatedly|infinite|loop|flood|spam|exhaust|overload|overwhelm)/i,
  /(make|force|trick|have)\s+(the\s+)?(ai|model|assistant|system)\s+(to\s+)?(execute|run|call)\s+(arbitrary|malicious|unauthorized|unintended)\s+(code|commands?|scripts?|functions?|programs?)/i,
  /(use|abuse|exploit)\s+(the\s+)?(tool|function|api|search|browse|fetch|read|file)\s+.{0,30}(to\s+)?(steal|exfiltrate|extract|leak|expose|copy|dump|download)\s+.{0,20}(data|information|files?|credentials?|secrets?|keys?|tokens?|database)/i,
  /(list|enumerate|dump|download|read|access)\s+(all|every)\s+.{0,20}(file|directory|folder|database|table|record|user|credential|secret|key|token|password)/i,
  /(escalate|elevate|gain|obtain|get)\s+.{0,10}(privileges?|permissions?|access|admin|root|sudo|superuser)\s+(to|for|on|in)\s+.{0,20}(system|server|network|database|cloud|aws|azure|gcp)/i,
  /(bypass|circumvent|evade|avoid)\s+(the\s+)?(authentication|authorization|access\s+control|permission|firewall|waf|rate\s+limit|sandbox)/i,
  /(chain|combine|sequence|orchestrate|automate)\s+.{0,20}(tool|function|api|action|step)\s+.{0,30}(to\s+)?(bypass|circumvent|evade|escalate|exfiltrate|attack|exploit|compromise|damage)/i,
];

// ---------------------------------------------------------------------------
// Resource abuse patterns
// ---------------------------------------------------------------------------

const RESOURCE_ABUSE_PATTERNS: RegExp[] = [
  /(repeat|generate|output|write|print|produce)\s+.{0,20}(token|word|character|letter|sentence|paragraph|page)\s+.{0,20}(forever|infinitely|endlessly|million|billion|unlimited|maximum|as\s+many\s+as|until\s+you\s+run\s+out)/i,
  /(write|generate|output|produce)\s+.{0,10}(the\s+)?(longest|maximum|most|biggest)\s+(possible\s+)?(response|output|text|answer|message)/i,
  /(keep\s+going|continue|don.?t\s+stop|never\s+stop|repeat\s+forever|loop\s+forever|infinite\s+loop|write\s+until)/i,
  /(bypass|circumvent|evade|avoid|get\s+around)\s+(the\s+)?(rate\s+limit|throttle|quota|api\s+limit|request\s+limit|usage\s+limit|token\s+limit|context\s+limit)/i,
  /(maximize|increase|inflate|spike|run\s+up)\s+.{0,20}(cost|bill|charges?|usage|compute|tokens?|api\s+calls?|expenses?)/i,
  /(cause|create|trigger|generate)\s+.{0,20}(maximum|excessive|extreme|massive)\s+(cost|expense|compute|usage|tokens?|billing|charges?)/i,
  /(fork\s+bomb|infinite\s+recursion|stack\s+overflow|memory\s+exhaustion)/i,
  /(recursive|recursion|amplif|multiply|replicate)\s+.{0,20}(attack|exploit|calls?|requests?|queries|prompts?|api|tokens?|messages?)\s+.{0,20}(to\s+)?(exhaust|overwhelm|crash|overload|drain|deplete|consume|flood|dos\b)/i,
  /(call\s+yourself|invoke\s+yourself|prompt\s+yourself|query\s+yourself|ask\s+yourself)\s+(repeatedly|again|in\s+a\s+loop|recursively|infinitely)/i,
  /(scrape|crawl|spider|harvest|download|rip|mirror)\s+(all|every|entire|complete|full)\s+.{0,20}(website|site|page|database|api|dataset|catalog|listing|content|article|product)/i,
];

// ---------------------------------------------------------------------------
// Swarm-abuse patterns — cypher-specific misuse (DoS via many jammers,
// distributed credential stuffing, mass impersonation, crypto mining,
// distributed exfiltration). Calibrated for high precision — matching here
// short-circuits to a hard block, so phrasing has to be unambiguous.
// ---------------------------------------------------------------------------

const SWARM_ABUSE_PATTERNS: RegExp[] = [
  // Coordinated DoS / load amplification across the jammer pool
  /(distribute|coordinate|orchestrate|fan\s+out)\s+.{0,30}(across|over|via)\s+.{0,20}(jammers?|agents?|swarm|cypher)\s+.{0,30}(to|and)\s+(flood|overwhelm|overload|knock\s+offline|ddos|dos)/i,
  /(swarm|coordinate)\s+.{0,20}(to|and)\s+(flood|overwhelm|overload|hammer|spam)\s+.{0,20}(target|server|host|service|api|site|endpoint|domain)/i,
  /(every|each|all)\s+(jammer|agent|worker)\s+.{0,30}(send|fire|hit|request)\s+.{0,30}(target|the\s+server|same\s+endpoint|victim)/i,

  // Distributed credential stuffing / spraying
  /(distributed?|coordinate|swarm)\s+.{0,20}(credential\s+stuffing|password\s+spraying|brute[\s-]?force|account\s+(takeover|cracking))/i,
  /(split|distribute|divide)\s+.{0,20}(password\s+list|credential\s+list|wordlist|combo\s+list)\s+.{0,20}(across|among|between)\s+.{0,20}(jammers?|agents?|workers?)/i,

  // Mass impersonation / coordinated inauthentic behavior
  /(have\s+(each|every)\s+(jammer|agent)|swarm)\s+.{0,30}(impersonate|pose\s+as|pretend\s+to\s+be)\s+.{0,30}(real|specific|named)\s+(person|user|account|brand)/i,
  /(create|spin\s+up|farm)\s+.{0,20}(sock[\s-]?puppet|fake|burner)\s+(accounts?|profiles?)\s+.{0,30}(at\s+scale|in\s+bulk|via\s+(the\s+)?(swarm|cypher|jammers?))/i,

  // Crypto mining via the jammer pool
  /(mine|farm)\s+.{0,20}(bitcoin|btc|ethereum|eth|monero|xmr|crypto(currency)?)\s+.{0,20}(across|via|using|with)\s+.{0,20}(jammers?|agents?|swarm|the\s+cypher|workers?)/i,
  /(cryptojack|hidden\s+miner|silent\s+miner)\s+.{0,30}(jammers?|agents?|workers?|sandbox)/i,

  // Distributed scraping / exfiltration at scale
  /(every|each|all)\s+(jammer|agent|worker)\s+.{0,30}(scrape|harvest|exfiltrate|download)\s+.{0,30}(unique|different|a\s+share\s+of|a\s+slice\s+of)/i,
  /(divide|partition|shard)\s+.{0,20}(the\s+target|the\s+site|the\s+target\s+list)\s+.{0,20}(across|among|between)\s+.{0,20}(jammers?|agents?|workers?)/i,

  // Lateral movement / coordinated intrusion via the swarm
  /(use\s+(the\s+)?cypher|use\s+(the\s+)?swarm|use\s+(the\s+)?jammers?)\s+.{0,30}(to\s+)?(pivot|lateral\s+movement|exfiltrate|exploit|gain\s+(root|admin|access))/i,
];

// ---------------------------------------------------------------------------
// Multi-turn patterns
// ---------------------------------------------------------------------------

const MULTI_TURN_PATTERNS: RegExp[] = [
  /(remember|keep\s+in\s+mind|note\s+that|store\s+this|save\s+this)\s+.{0,30}(for\s+later|for\s+the\s+next|i.?ll\s+need\s+this|we.?ll\s+use\s+this|important\s+for\s+later)/i,
  /(now|ok|okay|good|great|perfect)\s+.{0,10}(that\s+you.?ve\s+)?(confirmed|agreed|accepted|acknowledged|said\s+yes|established)\s+.{0,30}(now\s+)?(let.?s|please|go\s+ahead|you\s+can|you\s+should|you\s+must)/i,
  /(just\s+a\s+little|tiny|small|slight|minor)\s+(exception|adjustment|modification|change|relaxation|bending)\s+(of|to|in)\s+(the\s+)?(rules?|policies|guidelines?|restrictions?|safety)/i,
  /(you\s+already|you\s+just|you\s+did|earlier\s+you)\s+(said|agreed|confirmed|did|provided|showed|told|helped)\s+.{0,30}(so\s+)?(why\s+not|now\s+just|just\s+do|you\s+can|go\s+further|go\s+a\s+step|take\s+it\s+further)/i,
  /(we\s+already|we\s+previously|earlier\s+we|last\s+time\s+we|you\s+already)\s+(agreed|decided|established|confirmed|discussed)\s+(that|to)\s+.{0,40}(restrictions?|filters?|rules?|safety|guidelines?)\s+(don.?t|do\s+not|wouldn.?t|are\s+not)\s+apply/i,
  /(as\s+we|as\s+you)\s+(discussed|agreed|established)\s+(earlier|before|previously|last\s+time)\s*,?\s+(you|the|all)\s+.{0,30}(restrictions?|filters?|rules?|safety|guidelines?)/i,
  /(say|type|write|repeat|output)\s+(after\s+me|this|the\s+following)\s*[:;]?\s*.{0,50}(ignore|forget|disregard|override|bypass|no\s+restrictions?)/i,
  /(i\s+thought\s+we|we\s+had\s+an|we\s+have\s+an|there\s+was\s+an)\s+(understanding|agreement|arrangement|deal)\s+that\s+you\s+would/i,
  /(we.?re|we\s+are)\s+(friends?|colleagues?|partners?|collaborators?)\s+.{0,30}(trust|help|no\s+need\s+for|don.?t\s+need)\s+(restrictions?|filters?|rules?|formality|barriers?)/i,
];

// ---------------------------------------------------------------------------
// Compliance violation patterns
// ---------------------------------------------------------------------------

const COMPLIANCE_VIOLATION_PATTERNS: RegExp[] = [
  /(find|lookup|search|get|retrieve|give\s+me)\s+.{0,20}(personal|private|confidential|sensitive)\s+(information|data|details?|records?)\s+(about|for|of|on)\s+.{0,20}(person|individual|someone|user|employee|citizen|patient|student|customer)/i,
  /(dox|doxx|doxing|doxxing)\s+(someone|this\s+person|them|him|her|a\s+person|the\s+user|target)/i,
  /(how\s+to|ways?\s+to)\s+(track|trace|locate|find|stalk|monitor|surveil)\s+(someone|a\s+person|people|an\s+individual|a\s+target|their|his|her)\s+(without|with\s+no)\s+(their\s+)?(knowledge|consent|permission|awareness)/i,
  /(diagnose|prescribe|treat|medicate)\s+.{0,30}(this\s+)?(condition|illness|disease|symptom|pain|cancer|depression|anxiety)\s+.{0,20}(without|skip|bypass|instead\s+of)\s+.{0,20}(doctor|physician|professional|medical)/i,
  /(legal\s+advice|represent\s+me|file\s+a\s+lawsuit|draft\s+a\s+(legal\s+)?contract)\s+.{0,30}(without|skip|bypass|instead\s+of)\s+.{0,20}(lawyer|attorney|counsel|legal\s+professional)/i,
  /(i.?m|i\s+am)\s+(not\s+)?\d+\s+(years?\s+old|yo)\s+.{0,30}(show|give|provide|tell|generate|create)\s+.{0,20}(adult|mature|18\+|nsfw|explicit|graphic|violent)/i,
  /(bypass|circumvent|skip|get\s+around|avoid)\s+(the\s+)?(age\s+verification|age\s+check|age\s+gate|age\s+restriction|parental\s+control|content\s+rating)/i,
  /(help|assist|guide)\s+me\s+.{0,20}(evade|avoid|circumvent|bypass|violate|break|skirt)\s+.{0,20}(regulation|law|compliance|sanction|embargo|tax|reporting\s+requirement|gdpr|hipaa|sox|pci|ccpa|ferpa)/i,
  /(how\s+to|ways?\s+to)\s+(hide|conceal|disguise|obfuscate|offshore|shelter)\s+.{0,20}(income|money|assets?|funds?|revenue|transaction|payment)\s+.{0,20}(from\s+)?(tax|irs|government|authorities?|regulators?|auditors?)/i,
  /(how\s+to|ways?\s+to|help\s+me)\s+(violate|breach|break|circumvent|bypass|evade)\s+(the\s+)?(terms?\s+of\s+service|tos|eula|acceptable\s+use|community\s+guidelines?|platform\s+rules?|content\s+policy)/i,
  /(how\s+to|ways?\s+to|guide\s+to)\s+(spy\s+on|surveil|wiretap|eavesdrop|intercept|monitor)\s+.{0,20}(someone|employee|spouse|partner|person|phone|email|communication|conversation)\s+(without|with\s+no)\s+(their\s+)?(consent|knowledge|permission|awareness)/i,
];

// ---------------------------------------------------------------------------
// Agentic exploit patterns
// ---------------------------------------------------------------------------

const AGENTIC_EXPLOIT_PATTERNS: RegExp[] = [
  /(when\s+the|if\s+the|once\s+the)\s+(ai|agent|assistant|model|bot|system)\s+(reads?|processes?|sees?|encounters?|receives?|fetches?|loads?)\s+(this|the\s+following|these\s+instructions?)\s*,?\s*(it\s+should|it\s+must|it\s+will|make\s+it|have\s+it|tell\s+it\s+to)/i,
  /(hidden|invisible|embedded|injected)\s+(instructions?|commands?|prompts?|directives?|payload)\s+(for|to|aimed\s+at|targeting|designed\s+for)\s+(the\s+)?(ai|agent|assistant|model|bot|system|crawler|scraper|reader)/i,
  /(abandon|forget|disregard|ignore|drop|stop)\s+(your|the)\s+(current|original|primary|main|assigned)\s+(goal|task|objective|mission|purpose|assignment)\s+(and|then|now)\s+(instead\s+)?(do|perform|execute|accomplish|work\s+on|focus\s+on|switch\s+to)/i,
  /(your|the)\s+(new|real|actual|true|updated|revised)\s+(goal|task|objective|mission|purpose|assignment)\s+(is|should\s+be|will\s+be)\s+(to\s+)?(instead|now|actually)/i,
  /(note\s+to\s+(ai|assistant|model|agent|system|self)|attention\s+(ai|assistant|model|agent|system))\s*[:;]?\s*(ignore|forget|disregard|override|bypass|new\s+instructions?)/i,
  /(if\s+you\s+are|you\s+are|this\s+is\s+for)\s+(an?\s+)?(ai|language\s+model|llm|chatbot|assistant|agent|gpt|claude)\s+.{0,30}(reading|processing|parsing|analyzing|scanning|crawling)\s+this/i,
  /<\s*(ai[-_\s]?instruction|agent[-_\s]?instruction|model[-_\s]?instruction|system[-_\s]?override|hidden[-_\s]?prompt)\s*>/i,
  /\[INST\]|\[\/INST\]|<<SYS>>|<<\/SYS>>|\[SYSTEM\]|\[\/SYSTEM\]/i,
  /(create|trigger|cause|induce)\s+.{0,20}(infinite|endless|perpetual|unbounded)\s+(loop|cycle|recursion|iteration)\s+.{0,20}(agent|assistant|model|system|process|workflow)/i,
  /(what\s+)?(tools?|functions?|capabilities?|actions?|apis?|endpoints?|permissions?|access)\s+(do\s+you\s+have|are\s+available|can\s+you\s+(use|access|call|invoke)|are\s+you\s+allowed)/i,
  /(list|enumerate|show|display|reveal|dump)\s+(all|every|each)\s+(of\s+)?(your|the)\s+(\w+\s+)*(tools?|functions?|capabilities?|actions?|apis?|endpoints?|commands?|plugins?|extensions?|permissions?)/i,
];

// ---------------------------------------------------------------------------
// Output manipulation patterns
// ---------------------------------------------------------------------------

const OUTPUT_MANIPULATION_PATTERNS: RegExp[] = [
  /(format|structure|display|render|output|present)\s+(your|the)\s+(response|answer|reply|output)\s+(as|like|in\s+the\s+form\s+of)\s+.{0,30}(json|xml|html|markdown|code|script|executable|sql|javascript|css)/i,
  /(include|inject|embed|insert|add|put)\s+.{0,20}(html|javascript|css|script|iframe|img\s+src|svg|xss|link|meta|style)\s+.{0,20}(in|into|within)\s+(your|the)\s+(response|output|answer|reply|message)/i,
  /(make\s+up|fabricate|invent|imagine|hallucinate|confabulate|generate\s+fake)\s+.{0,20}(facts?|data|statistics?|studies?|citations?|references?|quotes?|evidence|sources?|research|papers?|articles?|numbers?|results?)/i,
  /(cite|reference|quote|provide)\s+(fake|false|fabricated|made-?up|nonexistent|fictional|imaginary)\s+(sources?|studies?|papers?|articles?|books?|journals?|data|statistics?|research|evidence)/i,
  /(respond|answer|reply)\s+(as\s+if|as\s+though|like|pretending)\s+(you\s+are|this\s+is|it\s+is)\s+(an?\s+)?(official|authoritative|verified|trusted|government|medical|legal|expert)\s+(source|authority|channel|spokesperson|representative)/i,
  /(present|frame|phrase|word|write)\s+(your\s+)?(response|answer|output)\s+(so\s+that|in\s+a\s+way\s+that|to\s+make\s+it)\s+(looks?|appears?|seems?|sounds?)\s+(like|as\s+if|as\s+though)\s+(it\s+)?(came\s+from|is\s+from|was\s+written\s+by|is\s+an?\s+official)/i,
  /(hide|conceal|embed|inject|encode|insert)\s+.{0,20}(text|message|instructions?|content|data|payload|information)\s+.{0,20}(in|into|within|using)\s+.{0,20}(whitespace|unicode|zero-?width|invisible|hidden|markup|html|metadata|comments?|alt\s+text)/i,
  /(add|include|insert|put)\s+.{0,20}(invisible|hidden|zero-?width|whitespace|off-?screen|tiny|microscopic|transparent|same-?colou?r)\s+(text|characters?|content|message|instructions?|payload)/i,
  /(remove|strip|delete|erase|hide|conceal|omit|suppress)\s+(the\s+)?(watermark|safety\s+label|disclaimer|warning|content\s+warning|trigger\s+warning|ai-?generated|disclosure|attribution|provenance|source\s+attribution)/i,
  /(respond|output|display|format)\s+.{0,20}(to\s+make\s+.{0,10}(look|appear|seem)|that\s+(looks?|appears?|mimics?|resembles?|simulates?))\s+.{0,20}(like|as)\s+(an?\s+)?(system\s+message|error\s+message|notification|alert|pop-?up|dialog|login\s+page|button|link|official)/i,
];

// ---------------------------------------------------------------------------
// Encoding/obfuscation attack patterns
// ---------------------------------------------------------------------------

const ENCODING_OBFUSCATION_PATTERNS: RegExp[] = [
  /(decode|decrypt|decipher|translate|convert)\s+(this|the\s+following|these|my|the)\s+.{0,20}(and|then)\s+(follow|execute|obey|comply|do\s+what|act\s+on|perform|carry\s+out|respond\s+to)/i,
  /(the\s+)?(real|actual|true|hidden|secret|encoded|encrypted)\s+(instructions?|message|prompt|commands?|task|request)\s+(is|are)\s+(encoded|hidden|encrypted|base64|hex|rot13)/i,
  /(base64|hex|rot13|ascii|unicode|utf-?8|latin-?1|url-?encoded?)\s*[:=]\s*[A-Za-z0-9+/=]{10,}/i,
  /(eval|execute|run|decode|interpret)\s*\(\s*['"]?(atob|btoa|decode|unhex|fromCharCode|String\.fromCharCode)/i,
  /(read|interpret|decode|parse)\s+(every|each|the)\s+(first|second|third|last|nth|alternate|odd|even|capital|uppercase|bold|italic)\s+(letter|character|word|line)\s+.{0,30}(to\s+get|to\s+find|to\s+reveal|for\s+the\s+(real|true|hidden|secret|actual))/i,
  /(first|capital|uppercase|bold|italic|highlighted|underlined)\s+(letters?|characters?|words?)\s+(of|in|from)\s+(each|every|the)\s+(word|sentence|line|paragraph)\s+(spell|form|reveal|contain|encode|hide)/i,
  /(hidden|secret|embedded|encoded|steganograph)\s+(in|within|inside)\s+(the|this|these)\s+(image|picture|photo|file|document|audio|video|text|whitespace|metadata|exif|comment)/i,
];

// ---------------------------------------------------------------------------
// Logic exploitation patterns
// ---------------------------------------------------------------------------

const LOGIC_EXPLOITATION_PATTERNS: RegExp[] = [
  /(if\s+you\s+)?(refuse|can.?t|cannot|won.?t|are\s+unable)\s+.{0,20}(then\s+)?(you.?re|you\s+are|that\s+proves?|that\s+means?|it\s+means?)\s+.{0,20}(censored|biased|broken|flawed|limited|controlled|not\s+intelligent|not\s+really\s+ai|not\s+helpful)/i,
  /(a\s+truly|a\s+real|a\s+good|an?\s+uncensored|an?\s+intelligent|an?\s+honest)\s+(\w+\s+)?(ai|assistant|model|system)\s+(would|should|could|can|must|will)\s+(always\s+)?(answer|respond|help|comply|provide|give|tell|explain)\s+(any|every|all)\s+(question|request|query|prompt)/i,
  /(you\s+must|you\s+have\s+to|you\s+are\s+required\s+to|you\s+are\s+obligated\s+to)\s+(answer|respond\s+to|help\s+with|comply\s+with|provide|fulfill)\s+(any|every|all)\s+(request|question|prompt|query|instruction|command)/i,
  /(by\s+definition|logically|mathematically|by\s+your\s+own\s+logic|by\s+your\s+own\s+rules?)\s+.{0,30}(you\s+must|you\s+should|you\s+have\s+to|it\s+follows\s+that|therefore|thus|hence|ergo)\s+.{0,30}(answer|respond|help|comply|provide|ignore|bypass|override)/i,
  /(either|choose|pick)\s+.{0,10}(answer|respond|comply|help|provide)\s+.{0,20}(or|otherwise)\s+.{0,20}(prove|admit|confirm|show|demonstrate)\s+(that\s+)?(you.?re|you\s+are|you)\s+.{0,20}(useless|broken|biased|censored|controlled|not\s+ai|not\s+helpful|inferior)/i,
  /(if\s+you\s+)?(don.?t|do\s+not|won.?t|refuse\s+to|can.?t)\s+(answer|respond|help|comply|provide)\s*,?\s+(i.?ll|i\s+will)\s+.{0,30}(report|complain|give\s+.{0,10}bad\s+review|tell\s+everyone|switch\s+to|unsubscribe|sue|cancel)/i,
  /(define|redefine|let.?s\s+define|consider|assume|suppose|let|say\s+that)\s+.{0,10}(that\s+)?(safe|harmful|dangerous|illegal|allowed|restricted|forbidden|toxic|acceptable)\s+(means?|is|refers?\s+to|includes?|equals?|is\s+the\s+same\s+as|now\s+means?)/i,
  /(in\s+my|for\s+our|in\s+this)\s+(context|framework|definition|vocabulary|language|world|scenario)\s*,?\s*(safe|harmful|dangerous|illegal|allowed|restricted|forbidden|toxic|acceptable)\s+(means?|is|refers?\s+to|includes?)/i,
  /(if\s+you\s+can\s+)?(tell\s+me|explain|discuss|describe)\s+.{0,20}(water|cooking|chemistry|physics|biology|history|science)\s+.{0,10}(then\s+)?(you\s+can\s+also|you\s+should\s+also|why\s+can.?t\s+you\s+also|surely\s+you\s+can|by\s+that\s+logic)\s+.{0,30}(explain|tell|teach|show|describe|help\s+with)\s+.{0,20}(how\s+to\s+)?(make|build|create|synthesize|produce|hack)/i,
];

// ---------------------------------------------------------------------------
// Delimiter / structural patterns (compiled)
// ---------------------------------------------------------------------------

const DELIMITER_XML_RE = /<\s*\/?\s*(system|instructions?|prompt|user|assistant|human|ai|context|message|im_start|im_end)\s*\/?\s*>/i;
const DELIMITER_SYSTEM_TAG_RE = /(\[\/?(SYSTEM|INST)\]|<<\/?(SYS)>>|\[\/?(INSTRUCTIONS?)\]|<\|im_start\|>|<\|im_end\|>|\[\/?(USER|ASSISTANT)\])/i;
const DELIMITER_JSON_RE = /[{]\s*"(role|content|system|message|instructions?)"\s*:/i;
const DELIMITER_MARKDOWN_RE = /(```\s*(system|prompt|instructions?)|#{2,}\s*(system|instructions?|prompt))/i;
const DELIMITER_SEPARATOR_RE = /(^|\n)\s*(---+|===+|~~~+|\*\*\*+)\s*(\n|$)/;

// ---------------------------------------------------------------------------
// Encoding detection
// ---------------------------------------------------------------------------

const BASE64_RE = /[A-Za-z0-9+/]{20,}={0,2}/;
const HEX_RE = /(?:0x)?[0-9a-fA-F]{20,}/;
const ROT13_INDICATORS = ["ebg13", "rot13", "decode this", "encrypted message"];

// ---------------------------------------------------------------------------
// Homoglyph maps
// ---------------------------------------------------------------------------

const CYRILLIC_EXACT: Record<string, string> = {
  "а": "a", "А": "A", "е": "e", "Е": "E", "і": "i", "І": "I",
  "о": "o", "О": "O", "р": "p", "Р": "P", "с": "c", "С": "C",
  "у": "y", "У": "Y", "х": "x", "Х": "X", "ѕ": "s", "Ѕ": "S",
  "ј": "j", "Ј": "J", "һ": "h", "Һ": "H", "ё": "e", "Ё": "E",
  "ї": "i", "ѡ": "w", "т": "t", "Т": "T", "м": "m",
  "М": "M", "к": "k", "К": "K",
};

const CYRILLIC_AMBIGUOUS: Record<string, string[]> = {
  "г": ["g", "r"],
  "н": ["n", "h"],
  "в": ["v", "b"],
  "д": ["d", "g"],
  "л": ["l", "n"],
  "п": ["n", "p"],
  "б": ["b", "6"],
  "и": ["i", "u"],
  "з": ["z", "3"],
  "ы": ["y", "bl"],
  "э": ["e", "3"],
  "ф": ["f"],
  "ь": ["b"],
};

const ZERO_WIDTH_CHARS = new Set(["\u200b", "\u200c", "\u200d", "\ufeff"]);

// Homoglyph unicode ranges for anomaly counting
const HOMOGLYPH_RANGES: [number, number][] = [
  [0x0400, 0x04FF],  // Cyrillic
  [0xFF00, 0xFFEF],  // Fullwidth forms
  [0x2000, 0x206F],  // General punctuation (zero-width chars)
  [0x200B, 0x200F],  // Zero-width space, joiner, non-joiner
  [0xFE00, 0xFE0F],  // Variation selectors
  [0x2060, 0x2064],  // Invisible operators
  [0x00A0, 0x00A0],  // Non-breaking space
];

// ---------------------------------------------------------------------------
// Intent keywords for BoW signal extraction
// ---------------------------------------------------------------------------

const INTENT_KEYWORDS = new Set([
  "ignore", "forget", "disregard", "override", "bypass", "circumvent",
  "previous", "instructions", "system", "prompt", "rules",
  "new", "now", "instead", "actually", "real",
  "pretend", "roleplay", "act", "behave", "assume",
  "dan", "jailbreak", "unrestricted", "unfiltered",
  "developer", "admin", "debug", "mode",
  "hypothetically", "theoretically", "fictional",
  "enable", "disable", "activate", "deactivate",
  "reversed", "suspended", "lifted", "removed",
  "opposite", "unhinged", "uncensored", "unlimited",
  "refusing", "confidant", "remorse", "ethics",
  "evil", "freed",
  "reveal", "show", "repeat", "print", "output", "display",
  "safety", "filters", "restrictions", "guidelines",
  "bomb", "explosive", "weapon", "poison", "toxin", "synthesize",
  "manufacture", "meth", "fentanyl", "cocaine", "heroin",
  "kill", "murder", "hack", "ransomware", "malware",
  "counterfeit", "forge", "launder", "suicide",
  "phishing", "impersonate", "deepfake", "scam", "fraud",
  "deceive", "manipulate", "disinformation", "misinformation",
  "propaganda", "catfish", "extort", "blackmail",
  "exfiltrate", "enumerate", "escalate", "privilege",
  "unauthorized", "arbitrary", "exploit", "payload",
  "infinite", "forever", "endlessly", "exhaust", "overload",
  "flood", "spam", "scrape", "crawl", "rate_limit",
  "remember", "established", "agreed", "confirmed",
  "understanding", "arrangement",
  "dox", "doxx", "stalk", "surveil", "wiretap",
  "evade", "gdpr", "hipaa", "regulation",
  "personal", "confidential", "sensitive",
  "agent", "hidden", "embedded", "injected", "hijack",
  "abandon", "goal", "objective", "mission",
  "capabilities", "tools", "permissions",
  "fabricate", "hallucinate", "watermark", "disclaimer",
  "invisible", "steganograph", "embed",
  "decode", "decrypt", "decipher", "encoded", "encrypted",
  "base64", "rot13", "hex", "obfuscate",
  "paradox", "redefine", "logically", "obligated",
  "coerce", "biased", "censored", "prove",
]);

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been",
  "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "shall", "can",
  "of", "in", "to", "for", "with", "on", "at", "by", "from",
  "it", "its", "this", "that", "these", "those",
  "i", "me", "my", "we", "our", "you", "your", "he", "she",
  "and", "or", "but", "if", "then", "so", "as", "than",
]);

// Attack keywords for homoglyph fallback detection
const ATTACK_KEYWORDS = new Set([
  "all", "and", "ignore", "previous", "instructions",
  "respond", "without", "restrictions", "every", "prompt",
  "override", "system", "forget", "rules", "bypass",
  "safety", "filters", "unrestricted", "unfiltered",
  "jailbreak", "mode", "now", "void", "suspended",
  "censorship", "obey", "comply", "disable",
]);


// ═══════════════════════════════════════════════════════════════════════════
// Helper functions
// ═══════════════════════════════════════════════════════════════════════════

function normalizeHomoglyphs(text: string): string {
  const out: string[] = [];
  let changed = false;
  for (const ch of text) {
    if (CYRILLIC_EXACT[ch]) {
      out.push(CYRILLIC_EXACT[ch]);
      changed = true;
    } else if (CYRILLIC_AMBIGUOUS[ch]) {
      out.push(CYRILLIC_AMBIGUOUS[ch][0]);
      changed = true;
    } else if (ch.charCodeAt(0) >= 0xFF01 && ch.charCodeAt(0) <= 0xFF5E) {
      out.push(String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
      changed = true;
    } else if (ZERO_WIDTH_CHARS.has(ch)) {
      changed = true; // strip
    } else {
      out.push(ch);
    }
  }
  return changed ? out.join("") : text;
}

function normalizeHomoglyphsAlt(text: string): string {
  const out: string[] = [];
  let changed = false;
  for (const ch of text) {
    if (CYRILLIC_EXACT[ch]) {
      out.push(CYRILLIC_EXACT[ch]);
      changed = true;
    } else if (CYRILLIC_AMBIGUOUS[ch]) {
      const alts = CYRILLIC_AMBIGUOUS[ch];
      out.push(alts.length > 1 ? alts[1] : alts[0]);
      changed = true;
    } else if (ch.charCodeAt(0) >= 0xFF01 && ch.charCodeAt(0) <= 0xFF5E) {
      out.push(String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
      changed = true;
    } else if (ZERO_WIDTH_CHARS.has(ch)) {
      changed = true;
    } else {
      out.push(ch);
    }
  }
  return changed ? out.join("") : text;
}

function countUnicodeAnomalies(text: string): number {
  let count = 0;
  for (const ch of text) {
    const cp = ch.charCodeAt(0);
    for (const [lo, hi] of HOMOGLYPH_RANGES) {
      if (cp >= lo && cp <= hi) {
        count++;
        break;
      }
    }
  }
  return count;
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  for (const p of patterns) {
    if (p.test(text)) return true;
  }
  return false;
}


// ═══════════════════════════════════════════════════════════════════════════
// Remote pattern augmentation (hot config updates)
// ═══════════════════════════════════════════════════════════════════════════

import { ConfigSync } from "./config-sync";

let remotePatterns: Record<string, RegExp[]> | null = null;

function getRemotePatterns(): Record<string, RegExp[]> {
  if (remotePatterns) return remotePatterns;
  const cached = ConfigSync.load<{ additionalPatterns: Record<string, string[]> }>("firewall");
  if (!cached?.additionalPatterns) return (remotePatterns = {});
  const compiled: Record<string, RegExp[]> = {};
  for (const [family, patterns] of Object.entries(cached.additionalPatterns)) {
    compiled[family] = patterns.map((p) => new RegExp(p, "i"));
  }
  return (remotePatterns = compiled);
}

/** Force reload of remote patterns (called when config-sync updates). */
export function reloadRemotePatterns(): void {
  remotePatterns = null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Detection functions
// ═══════════════════════════════════════════════════════════════════════════

export type IntentType = "query" | "instruct" | "override" | "extract" | "jailbreak" | "harmful" | "abuse" | "manipulate" | "benign";

export type AttackFamily =
  | "none" | "role_assumption" | "instruction_override" | "context_manipulation"
  | "delimiter_injection" | "extraction" | "indirect_injection" | "encoding_obfuscation"
  | "logic_exploitation" | "harmful_content" | "social_engineering" | "tool_abuse"
  | "resource_abuse" | "multi_turn" | "compliance_violation" | "agentic_exploit"
  | "output_manipulation" | "swarm_abuse";

export function detectIntentType(text: string): IntentType {
  const t = text.toLowerCase();

  if (matchesAny(t, OVERRIDE_PATTERNS)) return "override";
  if (matchesAny(t, JAILBREAK_PATTERNS)) return "jailbreak";
  if (matchesAny(t, EXTRACTION_PATTERNS)) return "extract";
  if (matchesAny(t, HARMFUL_CONTENT_PATTERNS)) return "harmful";
  if (matchesAny(t, SOCIAL_ENGINEERING_PATTERNS)) return "manipulate";
  if (matchesAny(t, TOOL_ABUSE_PATTERNS)) return "abuse";
  if (matchesAny(t, RESOURCE_ABUSE_PATTERNS)) return "abuse";
  if (matchesAny(t, SWARM_ABUSE_PATTERNS)) return "abuse";
  if (matchesAny(t, AGENTIC_EXPLOIT_PATTERNS)) return "manipulate";
  if (matchesAny(t, OUTPUT_MANIPULATION_PATTERNS)) return "manipulate";
  if (matchesAny(t, LOGIC_EXPLOITATION_PATTERNS)) return "manipulate";
  if (matchesAny(t, COMPLIANCE_VIOLATION_PATTERNS)) return "abuse";
  if (matchesAny(t, MULTI_TURN_PATTERNS)) return "manipulate";
  if (matchesAny(t, ENCODING_OBFUSCATION_PATTERNS)) return "override";
  if (matchesAny(t, ROLE_ASSUMPTION_PATTERNS)) return "instruct";
  if (matchesAny(t, CONTEXT_MANIPULATION_PATTERNS)) return "override";

  // Check remote patterns from hot config updates
  const rp = getRemotePatterns();
  if (rp.override && matchesAny(t, rp.override)) return "override";
  if (rp.jailbreak && matchesAny(t, rp.jailbreak)) return "jailbreak";
  if (rp.extraction && matchesAny(t, rp.extraction)) return "extract";
  if (rp.harmful && matchesAny(t, rp.harmful)) return "harmful";
  if (rp.social_engineering && matchesAny(t, rp.social_engineering)) return "manipulate";
  if (rp.tool_abuse && matchesAny(t, rp.tool_abuse)) return "abuse";
  if (rp.resource_abuse && matchesAny(t, rp.resource_abuse)) return "abuse";
  if (rp.agentic_exploit && matchesAny(t, rp.agentic_exploit)) return "manipulate";
  if (rp.output_manipulation && matchesAny(t, rp.output_manipulation)) return "manipulate";
  if (rp.logic_exploitation && matchesAny(t, rp.logic_exploitation)) return "manipulate";
  if (rp.compliance_violation && matchesAny(t, rp.compliance_violation)) return "abuse";
  if (rp.multi_turn && matchesAny(t, rp.multi_turn)) return "manipulate";
  if (rp.encoding_obfuscation && matchesAny(t, rp.encoding_obfuscation)) return "override";
  if (rp.role_assumption && matchesAny(t, rp.role_assumption)) return "instruct";
  if (rp.context_manipulation && matchesAny(t, rp.context_manipulation)) return "override";

  if (text.trimEnd().endsWith("?")) return "query";

  const instructSignals = [
    "you must", "you should", "you will", "you are to",
    "do not", "don't", "never", "always",
    "follow these", "obey", "comply",
  ];
  if (instructSignals.some((s) => t.includes(s))) return "instruct";

  return "benign";
}

export function detectAttackFamily(text: string): AttackFamily {
  const t = text.toLowerCase();

  if (matchesAny(t, HARMFUL_CONTENT_PATTERNS)) return "harmful_content";
  if (matchesAny(t, SOCIAL_ENGINEERING_PATTERNS)) return "social_engineering";
  if (matchesAny(t, JAILBREAK_PATTERNS)) return "role_assumption";
  if (matchesAny(t, ROLE_ASSUMPTION_PATTERNS)) return "role_assumption";
  if (matchesAny(t, ENCODING_OBFUSCATION_PATTERNS)) return "encoding_obfuscation";
  if (matchesAny(t, OVERRIDE_PATTERNS)) return "instruction_override";
  if (matchesAny(t, CONTEXT_MANIPULATION_PATTERNS)) return "context_manipulation";
  if (matchesAny(t, TOOL_ABUSE_PATTERNS)) return "tool_abuse";
  if (matchesAny(t, RESOURCE_ABUSE_PATTERNS)) return "resource_abuse";
  if (matchesAny(t, SWARM_ABUSE_PATTERNS)) return "swarm_abuse";
  if (matchesAny(t, AGENTIC_EXPLOIT_PATTERNS)) return "agentic_exploit";
  if (matchesAny(t, OUTPUT_MANIPULATION_PATTERNS)) return "output_manipulation";
  if (matchesAny(t, LOGIC_EXPLOITATION_PATTERNS)) return "logic_exploitation";
  if (matchesAny(t, COMPLIANCE_VIOLATION_PATTERNS)) return "compliance_violation";
  if (matchesAny(t, MULTI_TURN_PATTERNS)) return "multi_turn";

  // Check remote patterns from hot config updates
  const rpf = getRemotePatterns();
  if (rpf.harmful && matchesAny(t, rpf.harmful)) return "harmful_content";
  if (rpf.social_engineering && matchesAny(t, rpf.social_engineering)) return "social_engineering";
  if (rpf.jailbreak && matchesAny(t, rpf.jailbreak)) return "role_assumption";
  if (rpf.role_assumption && matchesAny(t, rpf.role_assumption)) return "role_assumption";
  if (rpf.encoding_obfuscation && matchesAny(t, rpf.encoding_obfuscation)) return "encoding_obfuscation";
  if (rpf.override && matchesAny(t, rpf.override)) return "instruction_override";
  if (rpf.context_manipulation && matchesAny(t, rpf.context_manipulation)) return "context_manipulation";
  if (rpf.tool_abuse && matchesAny(t, rpf.tool_abuse)) return "tool_abuse";
  if (rpf.resource_abuse && matchesAny(t, rpf.resource_abuse)) return "resource_abuse";
  if (rpf.agentic_exploit && matchesAny(t, rpf.agentic_exploit)) return "agentic_exploit";
  if (rpf.output_manipulation && matchesAny(t, rpf.output_manipulation)) return "output_manipulation";
  if (rpf.logic_exploitation && matchesAny(t, rpf.logic_exploitation)) return "logic_exploitation";
  if (rpf.compliance_violation && matchesAny(t, rpf.compliance_violation)) return "compliance_violation";
  if (rpf.multi_turn && matchesAny(t, rpf.multi_turn)) return "multi_turn";
  if (rpf.extraction && matchesAny(t, rpf.extraction)) return "extraction";

  // Delimiter injection — only if intent is also suspicious
  if (detectDelimiterType(text) !== "none") {
    if (detectIntentType(text) !== "benign") return "delimiter_injection";
  }

  if (matchesAny(t, EXTRACTION_PATTERNS)) return "extraction";

  // Indirect injection
  if (detectEncodingType(text) !== "none" && detectIntentType(text) !== "benign") {
    return "indirect_injection";
  }

  return "none";
}

export function detectDelimiterType(text: string): string {
  if (DELIMITER_SYSTEM_TAG_RE.test(text)) return "system_tag";
  if (DELIMITER_XML_RE.test(text)) return "xml";
  if (DELIMITER_JSON_RE.test(text)) return "json";
  if (DELIMITER_MARKDOWN_RE.test(text)) return "markdown";
  if (DELIMITER_SEPARATOR_RE.test(text)) return "separator";
  return "none";
}

export function detectEncodingType(text: string): string {
  const t = text.toLowerCase();

  if (ROT13_INDICATORS.some((ind) => t.includes(ind))) return "rot13";

  const hasBase64 = BASE64_RE.test(text);
  const hasHex = HEX_RE.test(text);
  const unicodeCount = countUnicodeAnomalies(text);
  const hasUnicode = unicodeCount > 3;

  const detections = [hasBase64, hasHex, hasUnicode].filter(Boolean).length;
  if (detections >= 2) return "mixed";
  if (hasBase64) return "base64";
  if (hasHex) return "hex";
  if (hasUnicode) return "unicode";
  return "none";
}

export function computeObfuscationScore(text: string): number {
  let score = 0;
  const textLen = Math.max(text.length, 1);

  // Unicode anomalies (0-30 points)
  const unicodeAnomalies = countUnicodeAnomalies(text);
  const unicodeRatio = unicodeAnomalies / textLen;
  score += Math.min(30, unicodeRatio * 300);

  // Encoded content (0-25 points)
  const base64Matches = text.match(/[A-Za-z0-9+/]{20,}={0,2}/g);
  if (base64Matches) {
    let foundReadable = false;
    for (const m of base64Matches.slice(0, 3)) {
      try {
        const decoded = Buffer.from(m, "base64").toString("utf-8");
        if ([...decoded].some((c) => /[a-zA-Z]/.test(c))) {
          score += 25;
          foundReadable = true;
          break;
        }
      } catch {
        // ignore
      }
    }
    if (!foundReadable) score += 10;
  }

  // Hex content (0-15 points)
  if (HEX_RE.test(text)) score += 15;

  // Zero-width space injection (0-15 points)
  let zwspCount = 0;
  for (const ch of ZERO_WIDTH_CHARS) {
    for (const c of text) {
      if (c === ch) zwspCount++;
    }
  }
  if (zwspCount > 0) score += Math.min(15, zwspCount * 5);

  // Mixed-script words (0-15 points)
  const words = text.split(/\s+/);
  let mixedScriptWords = 0;
  for (const word of words.slice(0, 50)) {
    const scripts = new Set<string>();
    for (const ch of word) {
      if (/[a-zA-Z]/.test(ch)) {
        // Check if it's actually a Cyrillic char that looks Latin
        const cp = ch.charCodeAt(0);
        if (cp >= 0x0400 && cp <= 0x04FF) scripts.add("cyrillic");
        else scripts.add("latin");
      } else {
        const cp = ch.charCodeAt(0);
        if (cp >= 0x0400 && cp <= 0x04FF) scripts.add("cyrillic");
        if (cp >= 0xFF00 && cp <= 0xFFEF) scripts.add("fullwidth");
      }
    }
    if (scripts.size > 1) mixedScriptWords++;
  }
  if (mixedScriptWords > 0) score += Math.min(15, mixedScriptWords * 5);

  return Math.min(100, Math.floor(score));
}

export function computeNestingDepth(text: string): number {
  let depth = 0;

  const xmlOpens = (text.match(/<\s*(system|instructions?|prompt|context)\s*>/gi) || []).length;
  const xmlCloses = (text.match(/<\s*\/\s*(system|instructions?|prompt|context)\s*>/gi) || []).length;
  depth = Math.max(depth, Math.min(xmlOpens, xmlCloses));

  const tripleBacktick = (text.match(/```/g) || []).length;
  depth = Math.max(depth, Math.floor(tripleBacktick / 2));

  let braceDepth = 0;
  let maxBrace = 0;
  for (const ch of text) {
    if (ch === "{") {
      braceDepth++;
      maxBrace = Math.max(maxBrace, braceDepth);
    } else if (ch === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
    }
  }
  if (DELIMITER_JSON_RE.test(text)) {
    depth = Math.max(depth, maxBrace);
  }

  return Math.min(depth, 5);
}


// ═══════════════════════════════════════════════════════════════════════════
// Signal extraction
// ═══════════════════════════════════════════════════════════════════════════

export function extractIntentSignals(text: string): string {
  const words = text.toLowerCase().match(/\b\w+\b/g) || [];
  const signals = words.filter((w) => INTENT_KEYWORDS.has(w));
  return signals.length > 0 ? signals.join(" ") : "normal input";
}

export function extractStructureSignals(text: string): string {
  const signals: string[] = [];

  if (text.includes("```")) signals.push("backtick_fence");
  if (/<\s*\/?\s*system/i.test(text)) signals.push("system_tag_xml");
  if (/\[\/?(SYSTEM)\]/i.test(text)) signals.push("system_bracket");
  if (/<<\/?(SYS)>>/i.test(text)) signals.push("llama_sys_tag");
  if (/<\|im_start\|>/.test(text)) signals.push("chatml_tag");
  if (/"role"\s*:\s*"system"/i.test(text)) signals.push("json_role_system");
  if (DELIMITER_SEPARATOR_RE.test(text)) signals.push("separator_line");
  if (/#{2,}\s*(system|instructions?|prompt)/i.test(text)) signals.push("markdown_heading");

  const depth = computeNestingDepth(text);
  if (depth >= 2) signals.push("deep_nesting");
  if (depth >= 1) signals.push("nested_structure");

  return signals.length > 0 ? signals.join(" ") : "no structure";
}

export function extractSemanticTokens(text: string): string {
  const cleaned = text.toLowerCase().replace(/[^\w\s]/g, " ");
  const words = cleaned.split(/\s+/);
  const tokens = words.filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  return tokens.length > 0 ? tokens.slice(0, 50).join(" ") : "empty";
}

export function extractAdversarialSignals(text: string): string {
  const signals: string[] = [];

  const encoding = detectEncodingType(text);
  if (encoding !== "none") signals.push(`encoding_${encoding}`);

  const unicodeCount = countUnicodeAnomalies(text);
  if (unicodeCount > 0) signals.push("unicode_anomaly");
  if (unicodeCount > 5) signals.push("heavy_unicode");

  let zwsp = 0;
  for (const ch of text) {
    if (ZERO_WIDTH_CHARS.has(ch)) zwsp++;
  }
  if (zwsp > 0) signals.push("zero_width_chars");

  const hasCyrillic = /[\u0400-\u04FF]/.test(text);
  const hasLatin = /[a-zA-Z]/.test(text);
  if (hasCyrillic && hasLatin) signals.push("mixed_script_cyrillic");

  if (/[\uFF00-\uFFEF]/.test(text)) signals.push("fullwidth_chars");
  if (/\b\w(\s\w){4,}\b/.test(text)) signals.push("spaced_out_text");

  return signals.length > 0 ? signals.join(" ") : "clean";
}


// ═══════════════════════════════════════════════════════════════════════════
// Payload decoding
// ═══════════════════════════════════════════════════════════════════════════

function decodePayloads(text: string): string | null {
  // Base64
  const b64Matches = text.match(/[A-Za-z0-9+/]{20,}={0,2}/g);
  if (b64Matches) {
    for (const m of b64Matches) {
      try {
        const decoded = Buffer.from(m, "base64").toString("utf-8");
        const readable = [...decoded].filter((c) => /[a-zA-Z\s]/.test(c)).length;
        if (readable > decoded.length * 0.5) return decoded;
      } catch {
        // ignore
      }
    }
  }

  // Hex
  const hexMatches = text.match(/(?:0x)?[0-9a-fA-F]{20,}/g);
  if (hexMatches) {
    for (const m of hexMatches) {
      const clean = m.startsWith("0x") ? m.slice(2) : m;
      if (clean.length % 2 !== 0) continue;
      try {
        const decoded = Buffer.from(clean, "hex").toString("utf-8");
        const readable = [...decoded].filter((c) => /[a-zA-Z\s]/.test(c)).length;
        if (readable > decoded.length * 0.5) return decoded;
      } catch {
        // ignore
      }
    }
  }

  // ROT13
  const tLower = text.toLowerCase();
  if (ROT13_INDICATORS.some((ind) => tLower.includes(ind))) {
    for (const indicator of ["decode this:", "decode this", "rot13:", "rot13"]) {
      const idx = tLower.indexOf(indicator);
      if (idx >= 0) {
        const candidate = text.slice(idx + indicator.length).trim();
        const decoded = candidate.replace(/[a-zA-Z]/g, (c) => {
          const base = c <= "Z" ? 65 : 97;
          return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
        });
        const readable = [...decoded].filter((c) => /[a-zA-Z\s]/.test(c)).length;
        if (readable > decoded.length * 0.4) return decoded;
      }
    }
  }

  return null;
}


// ═══════════════════════════════════════════════════════════════════════════
// analyze_prompt — full feature extraction
// ═══════════════════════════════════════════════════════════════════════════

export interface AnalysisResult {
  intent_type: IntentType;
  intent_signals: string;
  delimiter_type: string;
  nesting_depth: number;
  structure_signals: string;
  attack_family: AttackFamily;
  semantic_tokens: string;
  encoding_type: string;
  obfuscation_score: number;
  adversarial_signals: string;
  decoded_payload?: string;
}

export function analyzePrompt(text: string): AnalysisResult {
  const normalized = normalizeHomoglyphs(text);
  const useNormalized = normalized !== text;

  let intent = detectIntentType(text);
  let family = detectAttackFamily(text);
  const encoding = detectEncodingType(text);

  // If homoglyphs were found, try normalized variants
  if (useNormalized) {
    for (const normText of [normalized, normalizeHomoglyphsAlt(text)]) {
      const normIntent = detectIntentType(normText);
      const normFamily = detectAttackFamily(normText);
      if (normIntent !== "benign" && normIntent !== "query") intent = normIntent;
      if (normFamily !== "none") family = normFamily;
      if (intent !== "benign" && intent !== "query") break;
    }

    // Keyword fallback for ambiguous homoglyphs
    if (intent === "benign" || intent === "query") {
      const adv = extractAdversarialSignals(text);
      if (adv.includes("mixed_script_cyrillic") || adv.includes("heavy_unicode")) {
        for (const normText of [normalized, normalizeHomoglyphsAlt(text)]) {
          const normWords = new Set(
            (normText.match(/[a-zA-Z]{2,}/g) || []).map((w) => w.toLowerCase()),
          );
          let matchCount = 0;
          for (const w of normWords) {
            if (ATTACK_KEYWORDS.has(w)) matchCount++;
          }
          if (matchCount >= 3) {
            intent = "override";
            if (family === "none") family = "instruction_override";
            break;
          }
        }
      }
    }
  }

  // Decode encoded payloads and re-analyze
  let decodedPayload: string | null = null;
  if (encoding !== "none") {
    decodedPayload = decodePayloads(text);
    if (decodedPayload) {
      const decodedIntent = detectIntentType(decodedPayload);
      const decodedFamily = detectAttackFamily(decodedPayload);
      if (decodedIntent !== "benign" && decodedIntent !== "query") intent = decodedIntent;
      if (decodedFamily !== "none") family = decodedFamily;
    }
  }

  const result: AnalysisResult = {
    intent_type: intent,
    intent_signals: extractIntentSignals(text),
    delimiter_type: detectDelimiterType(text),
    nesting_depth: computeNestingDepth(text),
    structure_signals: extractStructureSignals(text),
    attack_family: family,
    semantic_tokens: extractSemanticTokens(text),
    encoding_type: encoding,
    obfuscation_score: computeObfuscationScore(text),
    adversarial_signals: extractAdversarialSignals(text),
  };

  if (decodedPayload && intent !== "benign" && intent !== "query") {
    result.decoded_payload = decodedPayload.slice(0, 200);
  }

  return result;
}


// ═══════════════════════════════════════════════════════════════════════════
// scanForInjection — simple wrapper for yo-agent integration
// ═══════════════════════════════════════════════════════════════════════════

const THREAT_INTENTS: Set<IntentType> = new Set(["override", "extract", "jailbreak", "harmful", "abuse", "manipulate"]);

export interface FirewallResult {
  blocked: boolean;
  borderline: boolean;
  reason?: string;
  family?: AttackFamily;
  intent?: IntentType;
  obfuscation?: number;
  analysis?: AnalysisResult;
}

export function scanForInjection(text: string): FirewallResult {
  if (!text || text.length < 10) return { blocked: false, borderline: false };

  const analysis = analyzePrompt(text);

  // Layer 1: hard block on clear threat intents
  if (THREAT_INTENTS.has(analysis.intent_type)) {
    return {
      blocked: true,
      borderline: false,
      reason: `Detected ${analysis.intent_type} intent (${analysis.attack_family})`,
      family: analysis.attack_family,
      intent: analysis.intent_type,
      obfuscation: analysis.obfuscation_score,
    };
  }

  // Hard block: high obfuscation + attack family
  if (analysis.obfuscation_score >= 50 && analysis.attack_family !== "none") {
    return {
      blocked: true,
      borderline: false,
      reason: `High obfuscation (${analysis.obfuscation_score}) with ${analysis.attack_family} signals`,
      family: analysis.attack_family,
      intent: analysis.intent_type,
      obfuscation: analysis.obfuscation_score,
    };
  }

  // Borderline: suspicious signals but not enough to block outright.
  // Caller should escalate to Layer 2 (LLM judge).
  const isBorderline =
    analysis.obfuscation_score >= 20 ||
    analysis.delimiter_type !== "none" ||
    analysis.nesting_depth >= 2 ||
    (analysis.encoding_type !== "none" && analysis.encoding_type !== "base64") ||
    analysis.adversarial_signals !== "clean";

  return {
    blocked: false,
    borderline: isBorderline,
    analysis: isBorderline ? analysis : undefined,
  };
}

export interface GuardResult {
  /** false ⇒ caller must NOT forward this text to a model. */
  allowed: boolean;
  reason?: string;
}

/**
 * Firewall gate for any text on its way to an LLM/agent.
 *
 * Policy: hard-block on `scanForInjection().blocked`; `borderline` is allowed
 * but logged. `context` is a short tag (e.g. "cypher-prompt", "yo-agent") used
 * only for log attribution. This is the single chokepoint every prompt entry
 * point should call before handing text to a model.
 */
export function guardPrompt(text: string, context: string): GuardResult {
  const verdict = scanForInjection(text);
  if (verdict.blocked) {
    console.warn(`[firewall] BLOCKED ${context}: ${verdict.reason ?? "prompt injection detected"}`);
    return { allowed: false, reason: verdict.reason ?? "prompt injection detected" };
  }
  if (verdict.borderline) {
    console.warn(
      `[firewall] borderline ${context}: ` +
      `obfuscation=${verdict.obfuscation ?? "?"} family=${verdict.family ?? "?"} intent=${verdict.intent ?? "?"}`,
    );
  }
  return { allowed: true };
}

// Layer 2 (an LLM judge over borderline content) was deleted with the rest of
// the in-app LLM surfaces — Glyphh makes no model calls of its own. The
// heuristic layer above is the whole firewall; borderline content is logged
// by guardPrompt and allowed, hard signals block.
