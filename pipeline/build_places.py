"""Places gazetteer + minimap image for the UI module (module "ui").

  python3 pipeline/build_places.py          (about 20-40 s)

Inputs (all local, see docs/ARCHITECTURE.md): Overture places / buildings / transportation segments /
base water / land use / infrastructure / divisions (data/raw/*.parquet), Sentinel-2 composite
(data/processed/terrain_ortho.npy or s2_rgb.npy), terrain water mask.

Outputs  public/data/places/
  places.json   compact gazetteer (UTF-8 JSON, world frame: x east, z south, metres, integers)
    {
      "version": 2, "generated": "...",
      "kinds":   { kind: [ru label, en label] },
      "boundary": [x0,z0,x1,z1,...]      city boundary (городской округ Невинномысск), simplified 25 m
      "items": [ {                       one entry per searchable place
          "n":  name (Russian, as in OSM/Overture),
          "k":  kind (see KINDS),
          "x","z": representative point,
          "r":  rank 1 (most important) .. 5 (minor)  -> label visibility + search ordering
          "c":  optional category label in Russian (e.g. "Аптека", "Кофейня"),
          "a":  optional address / context (street + house, or settlement name outside the city),
          "en": optional English name from the source data,
          "h":  optional label anchor height above ground (m),
          "d":  optional short description (curated landmarks), "de": English description,
          "al": optional aliases (alternative names; searchable),
          "p":  optional extra label points [x,z,...] (long streets, rivers, canals)
          "L":  optional length (m) for streets / water lines
      } ]
    }
  map.jpg       2048x2048 north-up map image covering the 20.48 km region (10 m/px): Sentinel-2 true
                colour (tone-mapped) + water tint + building footprints + roads + rail. Used by the
                minimap / big map (pixel (0,0) = x -10240, z -10240).

Transliteration for Latin search is done at runtime (src/modules/ui/translit.ts).
"""
import json
import math
import os
import re
import sys
import time
from collections import defaultdict

import numpy as np
import pyarrow.parquet as pq
import shapely
import shapely.ops
from shapely import affinity
from shapely.geometry import Point, LineString, MultiLineString

from config import RAW, PROC, WEB_DATA, REGION_HALF, to_local

OUT_DIR = os.path.join(WEB_DATA, "places")
os.makedirs(OUT_DIR, exist_ok=True)
T0 = time.time()
TR = to_local()


def log(*a):
    print(f"[{time.time() - T0:5.1f}s]", *a, flush=True)


def W(g):
    """lon/lat geometry -> world x/z geometry (z = -north)."""
    g = shapely.ops.transform(lambda X, Y: TR.transform(X, Y), g)
    return affinity.scale(g, 1, -1, origin=(0, 0))


def inside(x, z, margin=0.0):
    return abs(x) <= REGION_HALF - margin and abs(z) <= REGION_HALF - margin


def clean_name(s):
    if not s:
        return None
    s = re.sub(r"\s+", " ", s).strip().strip(",;")
    if len(s) < 2:
        return None
    # instagram-like handles / junk ("ekaterina_lash_nsk", "_._.b.r.u.n...", "Raduga.nev")
    if "_" in s or re.fullmatch(r"[A-Za-z0-9.]+\.[A-Za-z0-9]+", s):
        return None
    if re.fullmatch(r"[a-z0-9 .\-]+", s) and len(s) > 14:
        return None
    return s


def norm(s):
    s = s.lower().replace("ё", "е")
    s = re.sub(r"[«»\"'“”„()№#.,\-–—]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


# ----------------------------------------------------------------------------------------- kinds
KINDS = {
    "district": ["Район города", "District"],
    "settlement": ["Населённый пункт", "Settlement"],
    "landmark": ["Достопримечательность", "Landmark"],
    "church": ["Храм", "Church"],
    "monument": ["Памятник", "Monument"],
    "park": ["Парк", "Park"],
    "water": ["Водный объект", "Water"],
    "street": ["Улица", "Street"],
    "station": ["Ж/д станция", "Railway station"],
    "bus_station": ["Автовокзал", "Bus station"],
    "bus_stop": ["Остановка", "Bus stop"],
    "industry": ["Предприятие", "Industry"],
    "power": ["Энергетика", "Power"],
    "education": ["Образование", "Education"],
    "medical": ["Медицина", "Medical"],
    "culture": ["Культура", "Culture"],
    "sport": ["Спорт", "Sport"],
    "mall": ["Торговый центр", "Shopping centre"],
    "shop": ["Магазин", "Shop"],
    "food": ["Кафе и рестораны", "Food & drink"],
    "hotel": ["Гостиница", "Hotel"],
    "gov": ["Госучреждение", "Public service"],
    "fuel": ["АЗС", "Fuel"],
    "service": ["Услуги", "Services"],
    "allotment": ["Садовое товарищество", "Allotments"],
    "viewpoint": ["Смотровая точка", "Viewpoint"],
    "building": ["Здание", "Building"],
    "nature": ["Природа", "Nature"],
    "bridge": ["Мост", "Bridge"],
}

TAX_RU = {
    "grocery_store": "Продукты", "convenience_store": "Продукты", "supermarket": "Супермаркет",
    "superstore": "Гипермаркет", "gas_station": "АЗС", "restaurant": "Ресторан", "pizza_restaurant": "Пиццерия",
    "sushi_restaurant": "Суши", "italian_restaurant": "Ресторан", "buffet_restaurant": "Кафе",
    "fast_food_restaurant": "Фастфуд", "cafe": "Кафе", "coffee_shop": "Кофейня", "bar": "Бар",
    "hookah_bar": "Кальянная", "lounge": "Лаунж-бар", "dessert_shop": "Кондитерская",
    "pizza_delivery_service": "Пиццерия", "mobile_phone_store": "Салон связи", "electronics_store": "Электроника",
    "pharmacy": "Аптека", "hotel": "Гостиница", "bed_and_breakfast": "Гостиница", "shopping_mall": "Торговый центр",
    "park": "Парк", "post_office": "Пункт выдачи / почта", "school": "Школа", "middle_school": "Школа",
    "beauty_salon": "Салон красоты", "barber": "Барбершоп", "nail_salon": "Маникюр", "spa": "Спа",
    "shoe_store": "Обувь", "clothing_store": "Одежда", "womens_clothing_store": "Одежда",
    "fashion_and_apparel_store": "Одежда", "historic_site": "Историческое место", "dental_clinic": "Стоматология",
    "general_dentistry": "Стоматология", "train_station": "Ж/д станция", "nursery_and_gardening_store": "Цветы и сад",
    "campus_building": "Учебное заведение", "bank": "Банк", "bank_or_credit_union": "Банк",
    "health_care": "Медцентр", "doctors_office": "Клиника", "laboratory": "Лаборатория", "lake": "Озеро",
    "hardware_store": "Стройматериалы", "home_improvement_store": "Стройматериалы",
    "hardware_home_and_garden_store": "Стройматериалы", "furniture_store": "Мебель", "auto_dealer": "Автосалон",
    "stadium_arena": "Стадион", "flowers_and_gifts_store": "Цветы", "community_center": "Дом культуры",
    "hospital": "Больница", "driving_school": "Автошкола", "traffic_school": "Автошкола",
    "bowling_alley": "Боулинг", "cultural_center": "Культурный центр", "sporting_goods_store": "Спорттовары",
    "hunting_and_fishing_store": "Рыбалка и охота", "movie_theater": "Кинотеатр", "dance_studio": "Танцы",
    "dance_club": "Клуб", "amusement_park": "Аттракционы", "beach": "Пляж", "music_school": "Музыкальная школа",
    "music_venue": "Дом культуры", "library": "Библиотека", "monument": "Памятник", "police_station": "Полиция",
    "college_university": "Колледж", "history_museum": "Музей", "museum": "Музей", "gym": "Фитнес",
    "ice_skating_rink": "Ледовая арена", "sport_league": "Спортшкола", "sports_and_recreation": "Спорт",
    "bookstore": "Книги", "bus_station": "Автовокзал", "shipping_center": "Транспортная компания",
    "energy_company": "Энергетика", "manufacturer": "Производство",
    "industrial_equipment_manufacturer": "Производство", "automotive_service": "Автосервис",
    "automotive_repair": "Автосервис", "auto_detailing": "Автомойка", "tire_dealer_and_repair": "Шиномонтаж",
    "motorcycle_repair": "Мотосервис", "real_estate_service": "Недвижимость", "education": "Образование",
    "specialty_foods_store": "Продукты", "vitamin_and_supplement_store": "Спортпит", "fabric_store": "Ткани",
    "beauty_supply_store": "Косметика", "animal_rescue_service": "Ветклиника", "social_or_community_service": "МФЦ",
    "shopping": "Пункт выдачи", "arts_and_entertainment": "Досуг", "professional_service": "Услуги",
}


def kind_of_place(tax, basic):
    t = f"{tax or ''} {basic or ''}"
    if "train_station" in t:
        return "station", 2
    if "bus_station" in t:
        return "bus_station", 2
    if "gas_station" in t:
        return "fuel", 4
    if "hospital" in t:
        return "medical", 3
    if any(k in t for k in ("health", "clinic", "doctor", "dental", "dentistry", "pharmacy", "diagnostics", "laboratory")):
        return "medical", 4
    if any(k in t for k in ("college", "university", "campus")):
        return "education", 3
    if any(k in t for k in ("school", "education", "learning", "kindergarten")):
        return "education", 4
    if any(k in t for k in ("amusement_park", "beach")):
        return "park", 3
    if "park" in t:
        return "park", 2
    if "monument" in t:
        return "monument", 2
    if "historic" in t:
        return "monument", 3
    if any(k in t for k in ("museum", "movie_theater")):
        return "culture", 2
    if any(k in t for k in ("library", "cultural_center", "community_center", "music_venue")):
        return "culture", 3
    if any(k in t for k in ("stadium", "skating_rink")):
        return "sport", 2
    if any(k in t for k in ("sport", "gym", "fitness", "bowling", "dance_studio")):
        return "sport", 4
    if any(k in t for k in ("restaurant", "cafe", "coffee", "fast_food", "bar", "lounge", "food_service",
                            "eatery", "dance_club")):
        return "food", 4
    if "hotel" in t or "bed_and_breakfast" in t:
        return "hotel", 3
    if "shopping_mall" in t or "superstore" in t:
        return "mall", 3
    if "lake" in t:
        return "water", 3
    if any(k in t for k in ("police", "government", "social_or_community", "post_office")):
        return "gov", 3
    if any(k in t for k in ("bank", "financial")):
        return "service", 4
    if any(k in t for k in ("store", "shopping", "grocery", "convenience")):
        return "shop", 4
    if any(k in t for k in ("manufacturer", "industrial", "energy_company")):
        return "industry", 3
    return "service", 4


# --------------------------------------------------------------------------------- divisions
log("divisions")
LOCALITIES = []
CITY = None
for r in pq.read_table(os.path.join(RAW, "divisions_division_area.parquet")).to_pylist():
    nm = (r["names"] or {}).get("primary")
    g = W(shapely.from_wkb(r["geometry"]))
    if r["subtype"] == "county" and nm and "Невинномысск" in nm:
        CITY = g
    elif r["subtype"] == "locality":
        LOCALITIES.append((nm, g))
shapely.prepare(CITY)
for _, g in LOCALITIES:
    shapely.prepare(g)

SETTLEMENT_TYPE = {"Кочубеевское": "с.", "Ивановское": "с.", "Воронежское": "с.", "Рабочий": "пос.",
                   "Прогресс": "х."}


def locality_of(x, z):
    p = Point(x, z)
    for nm, g in LOCALITIES:
        if g.contains(p):
            t = SETTLEMENT_TYPE.get(nm)
            return f"{t} {nm}" if t else nm
    if CITY is not None and CITY.contains(p):
        return None  # Nevinnomyssk itself
    return "Кочубеевский округ"


ITEMS = []


def add(name, kind, x, z, rank, **kw):
    name = clean_name(name)
    if not name or not inside(x, z):
        return None
    it = {"n": name, "k": kind, "x": int(round(x)), "z": int(round(z)), "r": int(rank)}
    for k, v in kw.items():
        if v is None or v == "" or v == []:
            continue
        it[k] = v
    ITEMS.append(it)
    return it


def with_loc(addr, x, z):
    loc = locality_of(x, z)
    if not loc:
        return addr
    if addr and loc.split(" ")[-1] in addr:
        return addr
    return f"{addr}, {loc}" if addr else loc


# ------------------------------------------------------------------------ curated landmarks / districts
# Positions come from the local data (Overture / landmarks.json); facts from public sources
# (see docs/modules/ui.md). h = label height above ground.
CURATED = [
    # name, kind, x, z, rank, h, description
    ("Невинномысская ГРЭС", "power", -848, -2160, 1, 262,
     "Тепловая электростанция; первый турбогенератор пущен в июне 1960 г., мощность ≈1550 МВт. Дымовая труба ≈250 м — самая высокая точка города."),
    ("Невинномысский Азот (ЕвроХим)", "industry", 600, -2450, 1, 120,
     "Химический комбинат: первый аммиак получен в августе 1962 г.; крупный производитель азотных удобрений, входит в «ЕвроХим»."),
    ("Мемориал «Вечный огонь»", "monument", 182, 64, 1, 24,
     "Мемориал воинам Великой Отечественной войны в центре города, у бульвара Мира."),
    ("Кинотеатр «Мир»", "culture", -29, 174, 2, 18, None),
    ("Центральный парк культуры и отдыха", "park", -420, 110, 1, 16,
     "Городской парк на берегу Кубани с набережной и аттракционами."),
    ("Стадион «Химик»", "sport", -687, 295, 2, 24, None),
    ("Вокзал станции Невинномысская", "station", 1875, 1049, 1, 22,
     "Железнодорожный вокзал Северо-Кавказской железной дороги (линия Ростов — Минеральные Воды)."),
    ("Кафедральный собор Покрова Пресвятой Богородицы", "church", 1435, 2710, 1, 45,
     "Главный православный храм города."),
    ("Храм Преподобного Серафима Саровского", "church", 600, -116, 2, 36, None),
    ("Автовокзал", "bus_station", 1330, -163, 2, 14, "Автовокзал Невинномысска на бульваре Мира."),
    ("Дворец спорта «Олимп»", "sport", 906, -250, 2, 22, None),
    ("ДК Химиков", "culture", 917, 1823, 2, 22, None),
    ("Культурно-досуговый центр «Родина»", "culture", 829, 2181, 2, 20, None),
    ("Историко-краеведческий музей", "culture", 671, 1236, 2, 16, None),
    ("Ледовый дворец «Олимпийский»", "sport", 2870, 2136, 2, 20, None),
    ("Центральный рынок", "mall", -428, -495, 2, 14, None),
    ("Набережная Кубани", "viewpoint", -965, 339, 2, 10, "Прогулочная набережная у городского парка."),
    ("Плотина Невинномысского канала", "landmark", -2225, -1189, 1, 16,
     "Головное сооружение канала: здесь вода Кубани отводится в Невинномысский канал."),
    ("Кочубеевская ВЭС", "power", 5600, -7300, 1, 150,
     "Ветроэлектростанция: 84 ветроустановки, 210 МВт — одна из крупнейших ВЭС России (2021)."),
    ("Кубанская ГЭС-4", "power", 7042, -2751, 2, 30, "Гидроэлектростанция каскада Кубанских ГЭС."),
    ("Белая гора", "nature", 1600, -3177, 2, 20, None),
    ("Бульвар Мира", "street", 520, -60, 1, 8, "Главный бульвар города: сквер, фонтаны, Вечный огонь."),
]

DISTRICTS = [
    # name, x, z, rank, note
    ("Центр", 250, 150, 1, "Исторический и деловой центр: бульвар Мира, улицы Гагарина и Менделеева"),
    ("Фабрика", -1950, 2450, 1, "Микрорайон у шерстяного комбината"),
    ("Рождественское", -2370, 330, 1, "Микрорайон на левом берегу Кубани"),
    ("Головное", -1690, -1640, 2, "Район у головного сооружения Невинномысского канала"),
    ("ПРП", 3110, 1610, 2, "Микрорайон на востоке города"),
    ("Гвардейский", 4020, 1770, 2, "Микрорайон на восточной окраине"),
    ("ЗИП", 1550, 4050, 2, "Район у завода «Энергомера» (ЗИП), улица Апанасенко"),
    ("Красная Деревня", -1120, 5000, 2, "Район на юге, у платформы «Красная Деревня»"),
    ("Посёлок Северный", -950, -1030, 3, None),
    ("Зелёный Мыс", -2420, -2050, 3, "Садоводческие товарищества у канала"),
    ("ЖК «Станция Спортивная»", 3307, 2216, 3, "Новый жилой комплекс на востоке города"),
]


ALIASES = {
    "Невинномысская ГРЭС": ["НГРЭС", "ГРЭС", "Nevinnomysskaya GRES"],
    "Невинномысский Азот (ЕвроХим)": ["Невинномысский Азот", "Азот", "Еврохим", "EuroChem"],
    "Мемориал «Вечный огонь»": ["Вечный огонь", "Невинномысск, Вечный Огонь"],
    "Кинотеатр «Мир»": ["Кинотеатр \"Мир\""],
    "Центральный парк культуры и отдыха": ["Городской парк", "Горпарк", "ЦПКиО"],
    "Стадион «Химик»": ["Стадион Химик", "Стадион НГГТИ"],
    "Вокзал станции Невинномысская": ["Невинномысская", "Станция Невинномысская", "Невинномысск вокзал", "Ж/д вокзал", "Railway station"],
    "Кафедральный собор Покрова Пресвятой Богородицы": ["Покровский собор"],
    "Автовокзал": ["Автовокзал Невинномысск", "Невинномысск", "Bus station"],
    "Дворец спорта «Олимп»": ["Дворец спорта Олимп"],
    "ДК Химиков": ["Дворец культуры химиков"],
    "Культурно-досуговый центр «Родина»": ["Культурно-досуговый центр Родина", "Родина"],
    "Историко-краеведческий музей": ["Невинномысский историко-краеведческий музей"],
    "Ледовый дворец «Олимпийский»": ["Ледовый дворец Олимпийский"],
    "Плотина Невинномысского канала": ["Плотина", "красивый вид на плотину", "Головное сооружение"],
    "Кочубеевская ВЭС": ["ВЭС", "ветропарк", "wind farm"],
    "Кубанская ГЭС-4": ["ГЭС-4"],
}


DESC_EN = {
    "Невинномысская ГРЭС": ("Nevinnomysskaya GRES", "Thermal power station; first turbine started in June 1960, ≈1550 MW. Its ≈250 m chimney is the tallest structure in the city."),
    "Невинномысский Азот (ЕвроХим)": ("Nevinnomyssky Azot (EuroChem)", "Chemical works: first ammonia produced in August 1962; a major nitrogen-fertiliser producer, part of EuroChem."),
    "Мемориал «Вечный огонь»": ("Eternal Flame memorial", "Memorial to the soldiers of the Great Patriotic War in the city centre, by Mira Boulevard."),
    "Кинотеатр «Мир»": ("Mir cinema", None),
    "Центральный парк культуры и отдыха": ("Central Park", "City park on the Kuban river with an embankment and rides."),
    "Стадион «Химик»": ("Khimik stadium", None),
    "Вокзал станции Невинномысская": ("Nevinnomysskaya railway station", "Station of the North Caucasus Railway (Rostov — Mineralnye Vody line)."),
    "Кафедральный собор Покрова Пресвятой Богородицы": ("Cathedral of the Intercession", "The main Orthodox church of the city."),
    "Храм Преподобного Серафима Саровского": ("Church of St. Seraphim of Sarov", None),
    "Автовокзал": ("Bus station", "Nevinnomyssk bus station on Mira Boulevard."),
    "Дворец спорта «Олимп»": ("Olimp sports palace", None),
    "ДК Химиков": ("Chemists' House of Culture", None),
    "Культурно-досуговый центр «Родина»": ("Rodina cultural centre", None),
    "Историко-краеведческий музей": ("Local history museum", None),
    "Ледовый дворец «Олимпийский»": ("Olimpiysky ice palace", None),
    "Центральный рынок": ("Central market", None),
    "Набережная Кубани": ("Kuban embankment", "Riverside promenade by the city park."),
    "Плотина Невинномысского канала": ("Nevinnomyssk canal weir", "Canal head works: here Kuban water is diverted into the Nevinnomyssk canal."),
    "Кочубеевская ВЭС": ("Kochubeevskaya wind farm", "84 wind turbines, 210 MW — one of the largest wind farms in Russia (2021)."),
    "Кубанская ГЭС-4": ("Kuban HPP-4", "Hydroelectric plant of the Kuban cascade."),
    "Белая гора": ("Belaya Gora (White Hill)", None),
    "Бульвар Мира": ("Mira Boulevard", "The main boulevard: square, fountains, the Eternal Flame."),
    "Кубань": ("Kuban River", "The main river of the North Caucasus (870 km); flows through the city from south to north."),
    "Невинномысский канал": ("Nevinnomyssk Canal", "Irrigation and water-supply canal taking water from the Kuban at Nevinnomyssk."),
    "Большой Зеленчук": ("Bolshoy Zelenchuk", "Left tributary of the Kuban, joins it at Nevinnomyssk."),
    "Центр": ("City centre", "Historic and business centre: Mira Boulevard, Gagarina and Mendeleeva streets"),
}


def add_curated():
    for name, kind, x, z, rank, h, d in CURATED:
        en, de = DESC_EN.get(name, (None, None))
        add(name, kind, x, z, rank, h=h, d=d, cur=1, al=ALIASES.get(name), en=en, de=de)
    for name, x, z, rank, note in DISTRICTS:
        en, de = DESC_EN.get(name, (None, None))
        add(name, "district", x, z, rank, d=note, h=40, cur=1, en=en, de=de)
    for nm, g in LOCALITIES:
        p = g.representative_point()
        if not inside(p.x, p.y, 300):
            continue
        t = SETTLEMENT_TYPE.get(nm)
        area = g.area
        add(nm, "settlement", p.x, p.y, 1 if area > 2e6 else 2, a=f"{t} {nm}" if t else "Кочубеевский округ", h=60,
            cur=1)


add_curated()
log(len(ITEMS), "curated")

# ------------------------------------------------------------------------------------ places
log("places")
for r in pq.read_table(os.path.join(RAW, "places_place.parquet")).to_pylist():
    g = W(shapely.from_wkb(r["geometry"]))
    nm = (r["names"] or {}).get("primary")
    if not nm or "Невинномысск Невинномысск" in nm or nm in ("Bolchoï Zelentchouk",):
        continue
    tax = (r["taxonomy"] or {}).get("primary") if r["taxonomy"] else None
    basic = r["basic_category"]
    kind, rank = kind_of_place(tax, basic)
    conf = r["confidence"] or 0
    if conf < 0.45:
        rank += 1
    if nm.strip().lower() in ("wildberries", "wilberries", "сдэк", "ozon"):
        rank = 5
    if re.fullmatch(r"[a-z0-9]+", nm.strip()):
        rank = 5  # lower-case latin brand handles
    if tax is None and basic is None and conf < 0.6:
        rank = 5
    en = None
    for ru in ((r["names"] or {}).get("rules") or []):
        if ru.get("language") == "en" and ru.get("value") and ru["value"] != nm:
            en = ru["value"]
    addr = None
    if r["addresses"]:
        addr = r["addresses"][0].get("freeform")
        if addr:
            addr = re.sub(r"^(Россия,\s*)?(\d{6},\s*)?(Ставропольский край,?\s*)?", "", addr).strip(" ,")
            addr = re.sub(r"^(г\.?\s*|город\s+)?Невинномысск,?\s*", "", addr).strip(" ,")
            parts = [p.strip() for p in addr.split(",")]
            parts = [p for p in parts if p and not re.fullmatch(r"(г\.?\s*)?Невинномысск|Ставропольский край|Россия|\d{6}|городской округ Невинномысск", p)]
            addr = ", ".join(parts)
            if addr == nm or len(addr) < 3 or re.fullmatch(r"[\d/ ]+", addr):
                addr = None
    add(nm, kind, g.x, g.y, min(rank, 5), c=TAX_RU.get(tax), a=with_loc(addr, g.x, g.y), en=en, src="p")

# ------------------------------------------------------------------------------- named buildings
log("buildings")
BCLS = {
    "church": ("church", 2), "cathedral": ("church", 1), "train_station": ("station", 2), "hospital": ("medical", 3),
    "school": ("education", 3), "kindergarten": ("education", 4), "college": ("education", 3),
    "university": ("education", 3), "fire_station": ("gov", 3), "post_office": ("gov", 3), "hotel": ("hotel", 3),
    "retail": ("mall", 3), "commercial": ("service", 4), "industrial": ("industry", 3), "apartments": ("building", 4),
    "warehouse": ("industry", 4), "public": ("gov", 3),
}
BSUB = {"religious": ("church", 2), "medical": ("medical", 3), "education": ("education", 4), "civic": ("gov", 3),
        "commercial": ("service", 4), "industrial": ("industry", 3), "entertainment": ("culture", 3),
        "transportation": ("station", 3), "residential": ("building", 4)}
for r in pq.read_table(os.path.join(RAW, "buildings_building.parquet"),
                       columns=["names", "class", "subtype", "geometry", "num_floors"]).to_pylist():
    nm = (r["names"] or {}).get("primary")
    if not nm:
        continue
    g = W(shapely.from_wkb(r["geometry"]))
    p = g.representative_point()
    kind, rank = BCLS.get(r["class"]) or BSUB.get(r["subtype"]) or ("building", 4)
    low = nm.lower()
    if "детский сад" in low or "мбдоу" in low or "детсад" in low:
        kind, rank = "education", 4
    elif "школ" in low or "колледж" in low or "лицей" in low or "гимназ" in low:
        kind, rank = "education", 3
    elif "больниц" in low or "поликлин" in low or "роддом" in low or "гбуз" in low:
        kind, rank = "medical", 3
    elif "храм" in low or "собор" in low or "церк" in low:
        kind, rank = "church", 2
    elif "торгов" in low or "т.ц." in low or "тц " in low or "цум" == low:
        kind, rank = "mall", 3
    elif low in ("магнит", "пятёрочка", "пятерочка", "wildberries", "wilberries", "лукойл", "роснефть"):
        kind, rank = ("fuel", 4) if low in ("лукойл", "роснефть") else ("shop", 5 if "wil" in low else 4)
    h = None
    if r["num_floors"]:
        h = int(r["num_floors"] * 3 + 8)
    add(nm, kind, p.x, p.y, rank, a=with_loc(None, p.x, p.y), h=h, src="b")

# ---------------------------------------------------------------------------------- land use
log("land use")
LU_KIND = {
    ("education", "school"): ("education", 3), ("education", "kindergarten"): ("education", 4),
    ("education", "university"): ("education", 3), ("education", "driving_school"): ("education", 4),
    ("medical", "hospital"): ("medical", 2), ("park", "park"): ("park", 2),
    ("entertainment", "theme_park"): ("park", 1), ("recreation", "stadium"): ("sport", 2),
    ("developed", "industrial"): ("industry", 2), ("horticulture", "allotments"): ("allotment", 4),
    ("horticulture", "plant_nursery"): ("shop", 4), ("residential", "residential"): ("district", 2),
    ("residential", "garages"): ("service", 5), ("construction", "construction"): ("building", 4),
    ("protected", "natural_monument"): ("nature", 2),
}
for r in pq.read_table(os.path.join(RAW, "base_land_use.parquet")).to_pylist():
    nm = (r["names"] or {}).get("primary")
    if not nm:
        continue
    g = W(shapely.from_wkb(r["geometry"]))
    kind, rank = LU_KIND.get((r["subtype"], r["class"]), ("service", 4))
    p = g.representative_point()
    if kind == "district":
        # settlements are added from divisions already; keep only urban microdistricts
        if any(nm == ln for ln, _ in LOCALITIES):
            continue
        nm = re.sub(r"^[Мм]икрорайон\s+", "", nm)
        if kind == "district" and any(d[0] == nm for d in DISTRICTS):
            continue
    if kind == "industry" and g.area > 2e5:
        rank = 1 if g.area > 1e6 else 2
    add(nm, kind, p.x, p.y, rank, a=with_loc(None, p.x, p.y), src="lu")

for r in pq.read_table(os.path.join(RAW, "base_land.parquet")).to_pylist():
    nm = (r["names"] or {}).get("primary")
    if nm:
        p = W(shapely.from_wkb(r["geometry"])).representative_point()
        add(nm, "nature", p.x, p.y, 2, src="land")

# --------------------------------------------------------------------------------- infrastructure
log("infrastructure")
stops = defaultdict(list)
for r in pq.read_table(os.path.join(RAW, "base_infrastructure.parquet")).to_pylist():
    nm = (r["names"] or {}).get("primary")
    if not nm:
        continue
    cls = r["class"]
    g = W(shapely.from_wkb(r["geometry"]))
    p = g if g.geom_type == "Point" else g.representative_point()
    if cls == "bus_stop":
        stops[nm].append((p.x, p.y))
    elif cls in ("railway_station", "railway_halt"):
        add(nm if cls == "railway_halt" else f"Станция {nm}", "station", p.x, p.y, 2 if cls == "railway_station" else 3,
            c="Ж/д станция" if cls == "railway_station" else "Ж/д платформа", a=with_loc(None, p.x, p.y), src="i")
    elif cls == "viewpoint":
        add(nm[0].upper() + nm[1:], "viewpoint", p.x, p.y, 3, c="Смотровая точка", a=with_loc(None, p.x, p.y), src="i")
    elif cls == "plant":
        add(nm, "power", p.x, p.y, 2 if g.area > 2000 else 3, c="Электростанция", src="i")
    elif cls == "substation":
        add(f"ПС {nm}" if not nm.startswith("ПС") else nm, "power", p.x, p.y, 4, c="Подстанция", src="i")
    elif cls == "bus_station":
        add(nm, "bus_station", p.x, p.y, 3, c="Автостанция", a=with_loc(None, p.x, p.y), src="i")

for nm, pts in stops.items():
    # split same-named stops that are far apart (e.g. both directions vs. different places)
    groups = []
    for x, z in pts:
        for gr in groups:
            if math.hypot(gr[0][0] - x, gr[0][1] - z) < 250:
                gr.append((x, z))
                break
        else:
            groups.append([(x, z)])
    for gr in groups:
        x = sum(p[0] for p in gr) / len(gr)
        z = sum(p[1] for p in gr) / len(gr)
        add(nm, "bus_stop", x, z, 4, c="Остановка", a=with_loc(None, x, z), h=6, src="i")

# -------------------------------------------------------------------------------------- water
log("water")


def merge_lines(gs):
    u = shapely.unary_union(gs)
    if u.geom_type == "MultiLineString":
        return shapely.ops.linemerge(u)
    return u


def sample_line_points(geom, step):
    """Points every `step` metres along the lines of geom that fall inside the region."""
    out = []
    lines = list(geom.geoms) if hasattr(geom, "geoms") else [geom]
    for ln in lines:
        L = ln.length
        n = max(1, int(L // step))
        for i in range(n):
            q = ln.interpolate((i + 0.5) * L / n)
            if inside(q.x, q.y, 50):
                out.append((q.x, q.y))
    return out


water_lines = defaultdict(list)
for r in pq.read_table(os.path.join(RAW, "base_water.parquet")).to_pylist():
    nm = (r["names"] or {}).get("primary")
    if not nm:
        continue
    g = W(shapely.from_wkb(r["geometry"]))
    if g.geom_type in ("LineString", "MultiLineString"):
        clipped = g.intersection(shapely.box(-REGION_HALF, -REGION_HALF, REGION_HALF, REGION_HALF))
        if not clipped.is_empty:
            water_lines[(nm, r["class"])].append(clipped)
    else:
        p = g.representative_point()
        c = {"lake": "Озеро", "pond": "Пруд", "reservoir": "Водохранилище"}.get(r["class"], "Водоём")
        add(nm, "water", p.x, p.y, 3, c=c, a=with_loc(None, p.x, p.y), h=4, src="w")

WATER_INFO = {
    "Кубань": ("Река", 1, "Главная река Северного Кавказа (870 км); течёт через весь город с юга на север."),
    "Невинномысский канал": ("Канал", 1, "Обводнительно-оросительный канал: забирает воду Кубани у Невинномысска."),
    "Большой Зеленчук": ("Река", 2, "Левый приток Кубани, впадает в неё у Невинномысска."),
}
for (nm, cls), geoms in water_lines.items():
    u = merge_lines(geoms)
    L = u.length
    if L < 200:
        continue
    cat, rank, desc = WATER_INFO.get(nm, ({"river": "Река", "canal": "Канал", "stream": "Ручей"}.get(cls, "Водоток"),
                                          3 if cls != "stream" else 4, None))
    # main point: closest to the city centre
    q = shapely.ops.nearest_points(u, Point(0, 300))[0]
    pts = sample_line_points(u, 1800 if rank <= 2 else 2500)
    flat = []
    for x, z in pts:
        if math.hypot(x - q.x, z - q.y) > 600:
            flat += [int(round(x)), int(round(z))]
    en, de = DESC_EN.get(nm, (None, None))
    add(nm, "water", q.x, q.y, rank, c=cat, d=desc, p=flat[:40], L=int(L), h=3, src="w", en=en, de=de)

# ------------------------------------------------------------------------------------- streets
log("streets")
CLASS_RANK = {"motorway": 1, "trunk": 2, "primary": 2, "secondary": 2, "tertiary": 3, "residential": 4,
              "unclassified": 4, "living_street": 4, "pedestrian": 4, "service": 5, "track": 5, "footway": 5,
              "path": 5, "steps": 5, "cycleway": 5}
by_name = defaultdict(list)
for r in pq.read_table(os.path.join(RAW, "transportation_segment.parquet"),
                       columns=["names", "subtype", "class", "geometry"]).to_pylist():
    nm = (r["names"] or {}).get("primary")
    if not nm or r["subtype"] != "road":
        continue
    g = W(shapely.from_wkb(r["geometry"]))
    by_name[nm].append((g, r["class"]))


def cluster(geoms, eps=500.0):
    n = len(geoms)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    tree = shapely.STRtree(geoms)
    for i, g in enumerate(geoms):
        for j in tree.query(g, predicate="dwithin", distance=eps):
            a, b = find(i), find(int(j))
            if a != b:
                parent[a] = b
    out = defaultdict(list)
    for i in range(n):
        out[find(i)].append(i)
    return list(out.values())


nstreets = 0
for nm, segs in by_name.items():
    geoms = [s[0] for s in segs]
    for idx in cluster(geoms):
        gs = [geoms[i] for i in idx]
        u = merge_lines(gs)
        L = u.length
        best = min(CLASS_RANK.get(segs[i][1], 5) for i in idx)
        c = u.centroid
        q = shapely.ops.nearest_points(u, c)[0]
        if not inside(q.x, q.y):
            continue
        in_city = locality_of(q.x, q.y) is None
        if in_city and L > 3000 and best <= 3:
            best = max(1, best - 1)
        rank = best
        name = nm
        cat = "Улица"
        if nm == "«Кавказ»":
            name, cat, rank = "Трасса Р-217 «Кавказ»", "Федеральная трасса", 1 if in_city else 2
        elif "шоссе" in nm:
            cat = "Шоссе"
        elif "переулок" in nm:
            cat = "Переулок"
        elif "бульвар" in nm:
            cat = "Бульвар"
        elif "проезд" in nm:
            cat = "Проезд"
        elif " - " in nm or "(СК)" in nm:
            cat = "Автодорога"
        pts = sample_line_points(u, 450 if L < 4000 else 900)
        flat = []
        for x, z in pts:
            if math.hypot(x - q.x, z - q.y) > 200:
                flat += [int(round(x)), int(round(z))]
        add(name, "street", q.x, q.y, rank, c=cat, a=with_loc(None, q.x, q.y), p=flat[:48], L=int(L), h=4, src="s")
        nstreets += 1
log(nstreets, "street clusters")

# ------------------------------------------------------------------------- default category labels
KIND_C = {"education": "Учебное заведение", "medical": "Медучреждение", "gov": "Учреждение", "industry": "Предприятие",
          "church": "Храм", "sport": "Спорт", "culture": "Культура", "park": "Парк", "allotment": "Садовое товарищество",
          "bus_stop": "Остановка", "mall": "Торговый центр", "hotel": "Гостиница", "power": "Энергетика",
          "monument": "Памятник", "nature": "Природа", "viewpoint": "Смотровая точка", "shop": "Магазин",
          "food": "Кафе", "fuel": "АЗС", "station": "Ж/д станция", "district": "Район города"}
NAME_C = [("детский сад", "Детский сад"), ("мбдоу", "Детский сад"), ("школ", "Школа"), ("гимнази", "Гимназия"),
          ("лицей", "Лицей"), ("колледж", "Колледж"), ("техникум", "Колледж"), ("больниц", "Больница"), ("гбуз", "Больница"),
          ("поликлиник", "Поликлиника"), ("роддом", "Роддом"), ("стадион", "Стадион"), ("храм", "Храм"), ("собор", "Храм"),
          ("пожарн", "Пожарная часть"), ("почта", "Почта"), ("снт", "Садовое товарищество"), ("гэс", "Электростанция"),
          ("вэс", "Электростанция"), ("грэс", "Электростанция"), ("подстанц", "Подстанция"), ("завод", "Предприятие"),
          ("комбинат", "Предприятие")]
for it in ITEMS:
    if it.get("c") or it["k"] in ("street", "water", "settlement"):
        continue
    low = it["n"].lower()
    for key, c in NAME_C:
        if key in low:
            it["c"] = c
            break
    else:
        if it["k"] in KIND_C:
            it["c"] = KIND_C[it["k"]]

# ----------------------------------------------------------------------------------- de-duplicate
log("dedup", len(ITEMS))
KIND_PRI = {"district": 0, "settlement": 0, "landmark": 1, "church": 1, "monument": 1, "power": 1, "station": 1,
            "water": 1, "street": 1, "park": 2, "culture": 2, "sport": 2, "bus_station": 2, "industry": 2,
            "education": 3, "medical": 3, "mall": 3, "gov": 3, "hotel": 3, "nature": 3, "viewpoint": 3,
            "food": 4, "shop": 4, "fuel": 4, "service": 5, "allotment": 4, "bus_stop": 4, "building": 6}


def key_tokens(s):
    return set(t for t in norm(s).split() if len(t) > 2 and t not in {
        "улица", "мбоу", "мбдоу", "гбуз", "гбпоу", "детский", "сад", "невинномысск", "невинномысский",
        "невинномысская", "город", "городской", "ооо", "оао", "пао", "ао", "имени", "им"})


def same(a, b):
    na = [norm(a["n"])] + [norm(x) for x in a.get("al", [])]
    nb = [norm(b["n"])] + [norm(x) for x in b.get("al", [])]
    if set(na) & set(nb):
        return True
    ta, tb = key_tokens(a["n"]), key_tokens(b["n"])
    if not ta or not tb:
        return False
    inter = len(ta & tb)
    return inter / min(len(ta), len(tb)) >= 0.99 and inter >= 1 and (len(ta) <= 3 or len(tb) <= 3)


ITEMS.sort(key=lambda it: (0 if it.get("cur") else 1, it["r"], KIND_PRI.get(it["k"], 5)))
# pass 1: anything named like a curated landmark (name or alias) within 3 km merges into it
CUR_NAMES = {}
for it in ITEMS:
    if it.get("cur") and it["k"] not in ("district", "settlement"):
        for nm in [it["n"]] + it.get("al", []):
            CUR_NAMES.setdefault(norm(nm), it)
rest = []
for it in ITEMS:
    o = None if it.get("cur") else CUR_NAMES.get(norm(it["n"]))
    lim = 3000 if o is not None and o["k"] in ("power", "industry") else 400
    if o is not None and math.hypot(o["x"] - it["x"], o["z"] - it["z"]) < lim:
        for k in ("a", "c", "en"):
            if k not in o and k in it:
                o[k] = it[k]
        continue
    rest.append(it)
ITEMS = rest
kept = []
grid = defaultdict(list)
for it in ITEMS:
    gx, gz = it["x"] // 600, it["z"] // 600
    dup = None
    if it["k"] not in ("street", "bus_stop"):
        for dx in (-1, 0, 1):
            for dz in (-1, 0, 1):
                for o in grid[(gx + dx, gz + dz)]:
                    if o["k"] in ("street", "bus_stop") or o["k"] == "district" and it["k"] != "district":
                        continue
                    big = ("park", "industry", "power", "station")
                    lim = 220 if (o["k"] in big or it["k"] in big) else 150
                    if o.get("cur"):
                        lim = 600 if o["k"] in ("power", "industry") else 350
                    if math.hypot(o["x"] - it["x"], o["z"] - it["z"]) < lim and same(o, it):
                        dup = o
                        break
                if dup:
                    break
            if dup:
                break
    if dup:
        for k in ("a", "c", "en", "h", "d"):
            if k not in dup and k in it:
                dup[k] = it[k]
        dup["r"] = min(dup["r"], it["r"])
        if norm(it["n"]) != norm(dup["n"]) and it["n"] not in dup.get("al", []):
            dup.setdefault("al", []).append(it["n"])
        continue
    grid[(gx, gz)].append(it)
    kept.append(it)

for it in kept:
    it.pop("cur", None)
    it.pop("src", None)
    if "al" in it:
        seen, al = {norm(it["n"])}, []
        for a in it["al"]:
            if norm(a) not in seen:
                seen.add(norm(a))
                al.append(a)
        if al:
            it["al"] = al
        else:
            it.pop("al")
kept.sort(key=lambda it: (it["r"], KIND_PRI.get(it["k"], 5), it["n"]))
log(len(kept), "items after dedup")

# --------------------------------------------------------------------------------- city boundary
boundary = []
if CITY is not None:
    g = CITY if CITY.geom_type == "Polygon" else max(CITY.geoms, key=lambda p: p.area)
    g = g.simplify(25)
    for x, z in list(g.exterior.coords)[:-1]:
        boundary += [int(round(x)), int(round(z))]

out = {
    "version": 2,
    "generated": time.strftime("%Y-%m-%d %H:%M"),
    "kinds": KINDS,
    "boundary": boundary,
    "items": kept,
}
path = os.path.join(OUT_DIR, "places.json")
with open(path, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
log("wrote", path, os.path.getsize(path) // 1024, "KB")

# ------------------------------------------------------------------------------------ map image
if "--no-map" not in sys.argv:
    from PIL import Image, ImageDraw, ImageFilter

    log("map image")
    N = 2048
    SS = 2  # supersampling for vector overlays
    src = os.path.join(PROC, "terrain_ortho.npy")
    if not os.path.exists(src):
        src = os.path.join(PROC, "s2_rgb.npy")
    rgb = np.load(src).astype(np.float32)  # linear reflectance, row 0 = north
    # exposure + filmic-ish curve + sRGB
    x = np.clip(rgb * 3.2, 0, None)
    x = x / (1 + x * 0.35)
    lum = x.mean(axis=2, keepdims=True)
    x = lum + (x - lum) * 1.18
    x = np.clip(x, 0, 1)
    srgb = np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1 / 2.4) - 0.055)
    base = Image.fromarray((np.clip(srgb, 0, 1) * 255 + 0.5).astype(np.uint8), "RGB")

    # water tint from the terrain water mask (2049^2 vertex grid)
    wm_path = os.path.join(PROC, "terrain_water_mask.npy")
    if os.path.exists(wm_path):
        wm = np.load(wm_path)[:N, :N].astype(np.float32)
        wm_img = Image.fromarray((wm * 255).astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(0.8))
        tint = Image.new("RGB", (N, N), (38, 88, 128))
        base = Image.composite(tint, base, wm_img.point(lambda v: int(v * 0.7)))

    over = Image.new("RGBA", (N * SS, N * SS), (0, 0, 0, 0))
    dr = ImageDraw.Draw(over)
    S = N * SS / (2 * REGION_HALF)

    def px(x, z):
        return ((x + REGION_HALF) * S, (z + REGION_HALF) * S)

    # buildings
    tb = pq.read_table(os.path.join(RAW, "buildings_building.parquet"), columns=["geometry"]).to_pylist()
    nb = 0
    for r in tb:
        g = W(shapely.from_wkb(r["geometry"]))
        polys = list(g.geoms) if g.geom_type == "MultiPolygon" else [g]
        for pg in polys:
            if pg.geom_type != "Polygon":
                continue
            c = pg.centroid
            if not inside(c.x, c.y):
                continue
            pts = [px(x, z) for x, z in pg.exterior.coords]
            if len(pts) >= 3:
                dr.polygon(pts, fill=(236, 226, 214, 150))
                nb += 1
    log(nb, "building footprints drawn")

    ROAD_STYLE = {  # class: (width m, colour)
        "trunk": (16, (255, 200, 110, 235)), "primary": (14, (255, 214, 130, 235)),
        "secondary": (12, (255, 236, 170, 230)), "tertiary": (10, (255, 255, 255, 220)),
        "residential": (7, (255, 255, 255, 170)), "unclassified": (7, (255, 255, 255, 160)),
        "living_street": (6, (255, 255, 255, 150)), "service": (4, (255, 255, 255, 110)),
        "track": (3, (230, 220, 200, 90)), "pedestrian": (4, (255, 240, 230, 130)),
    }
    segs = pq.read_table(os.path.join(RAW, "transportation_segment.parquet"),
                         columns=["subtype", "class", "geometry"]).to_pylist()
    order = ["track", "service", "pedestrian", "living_street", "unclassified", "residential", "tertiary",
             "secondary", "primary", "trunk"]
    # casing pass then fill pass for a map look
    for pass_ in ("case", "fill"):
        for cls in order:
            st = ROAD_STYLE[cls]
            for r in segs:
                if r["subtype"] != "road" or r["class"] != cls:
                    continue
                g = W(shapely.from_wkb(r["geometry"]))
                pts = [px(x, z) for x, z in g.coords]
                w = max(1, int(round(st[0] * S * 0.55)))
                if pass_ == "case":
                    if cls in ("track", "service", "pedestrian"):
                        continue
                    dr.line(pts, fill=(40, 36, 30, 70), width=w + 2 * SS, joint="curve")
                else:
                    dr.line(pts, fill=st[1], width=w, joint="curve")
    # rail
    for r in segs:
        if r["subtype"] != "rail":
            continue
        g = W(shapely.from_wkb(r["geometry"]))
        pts = [px(x, z) for x, z in g.coords]
        dr.line(pts, fill=(70, 60, 70, 210), width=max(2, int(4 * S)), joint="curve")
    # city boundary
    if boundary:
        bp = [px(boundary[i], boundary[i + 1]) for i in range(0, len(boundary), 2)]
        bp.append(bp[0])
        dr.line(bp, fill=(255, 120, 90, 160), width=3 * SS, joint="curve")
    over = over.resize((N, N), Image.LANCZOS)
    img = base.convert("RGBA")
    img.alpha_composite(over)
    img = img.convert("RGB")
    mp = os.path.join(OUT_DIR, "map.jpg")
    img.save(mp, quality=80, optimize=True, progressive=True)
    log("wrote", mp, os.path.getsize(mp) // 1024, "KB")
log("done")
