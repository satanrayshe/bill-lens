"""Shared normalisation for medicine names, strengths and dosage forms.

Every data source (NPPA notifications, the PMBJP product list and the brand
composition table) is reduced to the same canonical "salt key", e.g.

    amoxicillin 500mg + clavulanic acid 125mg

so that a brand on a bill, a ceiling-price row and a Jan Aushadhi product can
be compared directly.
"""
import re

# Spelling variants and pharmacopoeial synonyms -> one canonical salt name.
SYNONYMS = {
    "amoxycillin": "amoxicillin",
    "amoxycillin trihydrate": "amoxicillin",
    "amoxicillin trihydrate": "amoxicillin",
    "potassium clavulanate": "clavulanic acid",
    "clavulanate potassium": "clavulanic acid",
    "clavulanate": "clavulanic acid",
    "diluted potassium clavulanate": "clavulanic acid",
    "acetylsalicylic acid": "aspirin",
    "acetylsalicylic acid (aspirin)": "aspirin",
    "thyroxine": "levothyroxine",
    "levo-thyroxine": "levothyroxine",
    "levo thyroxine": "levothyroxine",
    "l-thyroxine": "levothyroxine",
    "acetaminophen": "paracetamol",
    "albuterol": "salbutamol",
    "glyburide": "glibenclamide",
    "frusemide": "furosemide",
    "vitamin d3": "cholecalciferol",
    "nimesulid": "nimesulide",
    "esomeprazole magnesium": "esomeprazole",
    "s(-)amlodipine": "s-amlodipine",
    "s-(-)amlodipine": "s-amlodipine",
    "s amlodipine": "s-amlodipine",
    "levamlodipine": "s-amlodipine",
    "5-aminosalicylic acid": "mesalazine",
    "5-amino salicylic acid": "mesalazine",
    "5-amino salicylic acid (mesalazine/mesalamine)": "mesalazine",
    "mesalamine": "mesalazine",
    "ranitidine hcl": "ranitidine",
    "cyanocobalamin": "vitamin b12",
    "methylcobalamin": "methylcobalamin",
    "ascorbic acid": "vitamin c",
    "sodium valproate": "valproate",
    "valproic acid": "valproate",
    "divalproex": "valproate",
    "divalproex sodium": "valproate",
    "dicyclomine": "dicyclomine",
    "dicycloverine": "dicyclomine",
    "chlorphenamine": "chlorpheniramine",
    "chlorpheniramine maleate": "chlorpheniramine",
    "insulin human": "human insulin",
}

# Salt-form words that do not change the active moiety for price matching.
SALT_WORDS = {
    "hydrochloride", "hcl", "dihydrochloride", "monohydrochloride", "sodium", "potassium",
    "calcium", "besylate", "besilate", "maleate", "mesylate", "mesilate", "succinate",
    "tartrate", "bitartrate", "citrate", "sulphate", "sulfate", "phosphate", "bromide",
    "hydrobromide", "acetate", "trihydrate", "monohydrate", "dihydrate", "sesquihydrate",
    "hemihydrate", "fumarate", "hemifumarate", "propionate", "dipropionate", "magnesium",
    "disodium", "dipotassium", "hyclate", "furoate", "valerate", "anhydrous", "cilexetil",
    "medoxomil", "axetil", "proxetil", "pivoxil", "olamine", "nitrate", "lactate", "gluconate",
    "embonate", "pamoate", "xinafoate", "malate", "oxalate", "napsylate", "estolate",
    "stearate", "ethylsuccinate", "monosodium", "trometamol", "tromethamine", "arginine",
    "lysine", "decanoate", "enanthate", "zinc", "bisulphate", "bisulfate", "erbumine",
    "ip", "bp", "usp", "ph.eur", "eq", "equivalent", "to", "as",
}
# If stripping salt words leaves only one of these, the salt word was the drug.
ANIONS = {
    "chloride", "carbonate", "bicarbonate", "sulphate", "sulfate", "phosphate", "citrate",
    "gluconate", "hydroxide", "oxide", "iodide", "lactate", "acetate", "bromide", "fluoride",
    "valproate", "alginate", "picosulfate", "picosulphate", "trisilicate", "glycerophosphate",
    "chloride ip", "",
}

FORM_PATTERNS = [
    # order matters: first match wins
    ("tab_mr", r"\b(sr|er|xr|cr|mr|pr|xl|prolonged[- ]release|sustained[- ]release|extended[- ]release|modified[- ]release|controlled[- ]release)\b"),
    ("inj", r"\b(injection|inj|infusion|vial|ampoule|ampule|prefilled|pfs|i\.v\.|iv fluid)\b"),
    ("liquid", r"\b(syrup|syp|suspension|susp|oral liquid|oral solution|elixir|dry syrup|expectorant|linctus|oral drops|drops oral|liquid)\b"),
    ("eye_ear", r"\b(eye|ear|ophthalmic|otic|e/d|e/e drops)\b"),
    ("topical", r"\b(cream|ointment|oint|gel|lotion|dusting powder|topical|external|shampoo|soap|paint)\b"),
    ("inhal", r"\b(inhaler|rotacap|respule|respules|nebuli[sz]er|nebulising|transcap|nasal spray|spray)\b"),
    ("supp", r"\b(suppository|suppositories|pessary|vaginal)\b"),
    ("cap", r"\b(capsule|capsules|cap|caps|softgel|soft gelatin)\b"),
    ("tab", r"\b(tablet|tablets|tab|tabs|dt|md|chewable|dispersible|film[- ]coated|enteric[- ]coated|gastro[- ]resistant|uncoated)\b"),
    ("drops", r"\b(drop|drops)\b"),
    ("powder", r"\b(powder|sachet|granules|husk)\b"),
]


def form_class(text: str) -> str:
    t = " " + text.lower() + " "
    for name, pat in FORM_PATTERNS:
        if re.search(pat, t):
            if name == "tab_mr" and re.search(r"\b(capsule|cap)\b", t):
                return "cap_mr"
            return name
    return "other"


def clean_salt(name: str) -> str:
    s = name.lower()
    s = re.sub(r"\((?:a|b|c|d|e)\)", " ", s)  # NPPA (A) (B) markers
    s = re.sub(r"\b(ip|bp|usp)\b", " ", s)
    s = re.sub(r"[^a-z0-9()\-/ ]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip(" -")
    if s in SYNONYMS:
        return SYNONYMS[s]
    # drop parenthetical alternatives like "(mesalazine/mesalamine)" after synonym check
    s2 = re.sub(r"\(.*?\)", " ", s)
    s2 = re.sub(r"\s+", " ", s2).strip()
    if s2 in SYNONYMS:
        return SYNONYMS[s2]
    words = s2.split()
    kept = [w for w in words if w not in SALT_WORDS]
    core = " ".join(kept)
    if not kept or core in ANIONS or (len(kept) == 1 and kept[0] in ANIONS):
        core = s2  # salt word was the active ingredient (e.g. potassium chloride)
    return SYNONYMS.get(core, core)


UNIT_RE = r"(mg|mcg|µg|ug|g|gm|iu|i\.u\.|%|ml|lakh iu|million iu)"
NUM = r"(\d+(?:\.\d+)?)"


def to_mg(value: float, unit: str):
    u = unit.lower().replace(".", "")
    if u in ("mg",):
        return value, "mg"
    if u in ("mcg", "µg", "ug"):
        return value / 1000.0, "mg"
    if u in ("g", "gm"):
        return value * 1000.0, "mg"
    if u in ("iu",):
        return value, "iu"
    if u == "lakh iu":
        return value * 100000, "iu"
    if u == "million iu":
        return value * 1000000, "iu"
    if u == "%":
        return value, "%"
    return value, u


def fmt_num(x: float) -> str:
    if abs(x - round(x)) < 1e-9:
        return str(int(round(x)))
    return ("%.4f" % x).rstrip("0").rstrip(".")


def strength_tokens(text: str):
    """Return list of strengths found in text, each as canonical string.

    "250 mg/5 mL" -> "50mg/ml"; "500 mg" -> "500mg"; "50mcg" -> "0.05mg".
    """
    t = text.lower().replace(",", "")
    out = []
    pat = re.compile(NUM + r"\s*" + UNIT_RE + r"(?:\s*(?:/|per)\s*" + r"(\d+(?:\.\d+)?)?\s*(ml|g|gm)\b)?")
    for m in pat.finditer(t):
        val = float(m.group(1))
        unit = m.group(2)
        if unit == "ml" and not m.group(4):
            continue  # a volume, not a strength
        v, u = to_mg(val, unit)
        if m.group(4):
            denom = float(m.group(3)) if m.group(3) else 1.0
            out.append(f"{fmt_num(v / denom)}{u}/{m.group(4).replace('gm', 'g')}")
        else:
            out.append(f"{fmt_num(v)}{u}")
    return out


def make_key(pairs):
    """pairs: list of (salt, strength) -> canonical key, sorted by salt."""
    pairs = sorted(pairs, key=lambda p: p[0])
    return " + ".join(f"{s} {st}".strip() for s, st in pairs)
