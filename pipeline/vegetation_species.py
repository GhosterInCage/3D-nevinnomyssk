"""Species table shared by pipeline/build_vegetation.py and the runtime module
(src/modules/vegetation/species.ts uses the same numeric ids - keep in sync).

Heights / crown widths are typical mature values for the North Caucasus
foothills (Stavropol Krai) - see docs/modules/vegetation.md.
"""

# id: (name, kind, height range m, crown width / height ratio range)
SPECIES = {
    0: ("poplar_italica", "tree", (17, 28), (0.16, 0.24)),   # Populus nigra 'Italica' - columnar
    1: ("poplar_black", "tree", (18, 28), (0.45, 0.6)),       # Populus nigra / x canadensis
    2: ("poplar_white", "tree", (16, 26), (0.5, 0.65)),       # Populus alba (silvery)
    3: ("willow", "tree", (11, 20), (0.7, 0.95)),             # Salix alba - riparian
    4: ("robinia", "tree", (11, 18), (0.5, 0.7)),             # Robinia pseudoacacia ("акация")
    5: ("chestnut", "tree", (12, 19), (0.6, 0.75)),           # Aesculus hippocastanum
    6: ("linden", "tree", (13, 21), (0.5, 0.65)),             # Tilia cordata
    7: ("maple", "tree", (11, 17), (0.6, 0.8)),               # Acer platanoides
    8: ("boxelder", "tree", (7, 13), (0.75, 1.0)),            # Acer negundo (weedy, multi-stem)
    9: ("elm", "tree", (9, 16), (0.6, 0.8)),                  # Ulmus pumila (Siberian elm)
    10: ("walnut", "tree", (11, 19), (0.8, 1.0)),             # Juglans regia
    11: ("fruit", "tree", (4, 8), (0.8, 1.1)),                # apple / apricot / plum / pear
    12: ("cherry", "tree", (3.5, 6.5), (0.75, 1.0)),          # Prunus cerasus / avium
    13: ("oak", "tree", (15, 24), (0.7, 0.9)),                # Quercus robur
    14: ("ash", "tree", (15, 24), (0.5, 0.65)),               # Fraxinus excelsior / pennsylvanica
    15: ("birch", "tree", (13, 21), (0.35, 0.5)),             # Betula pendula
    16: ("pine", "tree", (11, 20), (0.35, 0.5)),              # Pinus sylvestris / nigra
    17: ("spruce", "tree", (9, 18), (0.35, 0.45)),            # Picea pungens (blue spruce) / abies
    18: ("thuja", "tree", (3, 8), (0.3, 0.42)),               # Thuja occidentalis
    19: ("alder", "tree", (11, 18), (0.45, 0.6)),             # Alnus glutinosa
    32: ("lilac", "shrub", (2.0, 4.0), (0.8, 1.2)),           # Syringa vulgaris
    33: ("shrub", "shrub", (1.4, 3.2), (0.9, 1.3)),           # privet / elder / hawthorn
    34: ("rose", "shrub", (0.8, 2.0), (1.0, 1.5)),            # dog rose / sloe / blackthorn
    35: ("willow_shrub", "shrub", (2.5, 5.5), (0.9, 1.3)),    # Salix triandra / purpurea
    36: ("hedge", "hedge", (0.8, 1.5), (0, 0)),               # clipped privet hedge (crown = length)
    37: ("juniper", "shrub", (0.6, 1.6), (1.4, 2.4)),         # Juniperus sabina (spreading)
}

NAME_TO_ID = {v[0]: k for k, v in SPECIES.items()}

# Species mixes (weights) per placement zone.
MIX = {
    # riparian forest along the Kuban / Bolshoy Zelenchuk / canal
    "riparian": {"willow": 34, "poplar_white": 22, "poplar_black": 14, "alder": 10, "ash": 6,
                  "elm": 5, "boxelder": 6, "robinia": 3},
    # upland / plantation forest and woods
    "forest": {"oak": 26, "ash": 18, "robinia": 16, "maple": 8, "elm": 8, "boxelder": 6,
                "poplar_black": 5, "pine": 6, "birch": 3, "fruit": 4},
    # shelterbelts (лесополосы) along field edges and roads
    "shelterbelt": {"robinia": 30, "poplar_italica": 12, "poplar_black": 8, "elm": 16, "ash": 12,
                     "oak": 8, "boxelder": 6, "fruit": 5, "walnut": 3},
    # apartment-block courtyards, institutions, industrial greenery
    "urban": {"poplar_black": 12, "poplar_italica": 7, "robinia": 14, "maple": 12, "boxelder": 8,
               "linden": 9, "chestnut": 8, "elm": 10, "birch": 5, "ash": 4, "walnut": 4,
               "fruit": 3, "cherry": 2, "spruce": 3, "pine": 2},
    # parks, squares, memorials
    "park": {"linden": 16, "chestnut": 14, "maple": 12, "oak": 8, "ash": 6, "birch": 8,
              "spruce": 10, "pine": 8, "thuja": 5, "robinia": 6, "poplar_black": 4, "elm": 3},
    "cemetery": {"thuja": 20, "spruce": 14, "robinia": 16, "elm": 14, "boxelder": 10, "pine": 8,
                  "linden": 6, "cherry": 6, "birch": 6},
    # private sector (detached houses with gardens)
    "private": {"fruit": 30, "cherry": 17, "walnut": 17, "robinia": 5, "elm": 6, "poplar_italica": 3,
                 "maple": 4, "boxelder": 4, "spruce": 5, "thuja": 4, "pine": 2, "linden": 3},
    # dacha allotments (СНТ): orchards
    "allotments": {"fruit": 46, "cherry": 26, "walnut": 12, "robinia": 4, "boxelder": 4, "poplar_italica": 3,
                    "thuja": 2, "spruce": 3},
    "industrial": {"poplar_black": 22, "poplar_italica": 10, "elm": 20, "boxelder": 18, "robinia": 18,
                    "ash": 6, "birch": 3, "maple": 3},
    # street rows (chosen per street run)
    "street_city": {"linden": 15, "chestnut": 14, "poplar_italica": 13, "maple": 11, "robinia": 11,
                     "poplar_black": 8, "elm": 8, "ash": 5, "birch": 5, "spruce": 6, "walnut": 4},
    "street_private": {"walnut": 18, "fruit": 22, "cherry": 16, "robinia": 10, "elm": 8, "poplar_italica": 7,
                        "maple": 6, "boxelder": 5, "spruce": 4, "thuja": 4},
}

SHRUB_MIX = {
    "urban": {"lilac": 34, "shrub": 50, "rose": 8, "juniper": 8},
    "park": {"lilac": 30, "shrub": 40, "juniper": 18, "rose": 12},
    "private": {"lilac": 40, "shrub": 40, "rose": 12, "juniper": 8},
    "riparian": {"willow_shrub": 70, "shrub": 18, "rose": 12},
    "forest": {"shrub": 50, "rose": 35, "lilac": 5, "willow_shrub": 10},
    "steppe": {"rose": 70, "shrub": 30},
}
