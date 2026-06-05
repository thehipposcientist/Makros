from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets" / "images"
OUT = ROOT / "marketing" / "instagram"

FONT_PATH = "/System/Library/Fonts/Avenir Next.ttc"
FONT_BOLD = 8
FONT_DEMI = 2
FONT_MEDIUM = 5
FONT_REGULAR = 7

COLORS = {
    "background": "#060B14",
    "surface": "#0C1420",
    "surface_raised": "#14202E",
    "border": "#1C2C3E",
    "primary": "#40E8A0",
    "primary_light": "#80F8C8",
    "accent": "#60B8F0",
    "text": "#E8F0F8",
    "muted": "#90A8C0",
    "deep": "#03070D",
    "amber": "#E8B040",
}


def hex_to_rgba(value: str, alpha: int = 255) -> tuple[int, int, int, int]:
    value = value.strip("#")
    return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16), alpha


def font(size: int, face: int = FONT_REGULAR) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT_PATH, size, index=face)


def open_rgba(path: Path) -> Image.Image:
    return Image.open(path).convert("RGBA")


def crop_cover(image: Image.Image, size: tuple[int, int], focus: tuple[float, float] = (0.5, 0.5)) -> Image.Image:
    target_w, target_h = size
    scale = max(target_w / image.width, target_h / image.height)
    next_size = (math.ceil(image.width * scale), math.ceil(image.height * scale))
    resized = image.resize(next_size, Image.Resampling.LANCZOS)
    overflow_x = max(0, resized.width - target_w)
    overflow_y = max(0, resized.height - target_h)
    left = int(overflow_x * focus[0])
    top = int(overflow_y * focus[1])
    return resized.crop((left, top, left + target_w, top + target_h))


def rounded_mask(size: tuple[int, int], radius: int) -> Image.Image:
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size[0], size[1]), radius=radius, fill=255)
    return mask


def paste_rounded(base: Image.Image, image: Image.Image, xy: tuple[int, int], radius: int) -> None:
    mask = rounded_mask(image.size, radius)
    base.paste(image, xy, mask)


def add_shadow(
    base: Image.Image,
    box: tuple[int, int, int, int],
    radius: int,
    blur: int = 28,
    opacity: int = 150,
    offset: tuple[int, int] = (0, 18),
) -> None:
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    shifted = (box[0] + offset[0], box[1] + offset[1], box[2] + offset[0], box[3] + offset[1])
    draw.rounded_rectangle(shifted, radius=radius, fill=(0, 0, 0, opacity))
    layer = layer.filter(ImageFilter.GaussianBlur(blur))
    base.alpha_composite(layer)


def overlay_gradient(
    base: Image.Image,
    direction: str,
    start_alpha: int,
    end_alpha: int,
    color: str = "#000000",
) -> None:
    r, g, b, _ = hex_to_rgba(color)
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    if direction == "vertical":
        for y in range(base.height):
            t = y / max(1, base.height - 1)
            alpha = int(start_alpha + (end_alpha - start_alpha) * t)
            draw.line((0, y, base.width, y), fill=(r, g, b, alpha))
    else:
        for x in range(base.width):
            t = x / max(1, base.width - 1)
            alpha = int(start_alpha + (end_alpha - start_alpha) * t)
            draw.line((x, 0, x, base.height), fill=(r, g, b, alpha))
    base.alpha_composite(overlay)


def add_vignette(base: Image.Image, opacity: int = 160) -> None:
    mask = Image.new("L", base.size, 0)
    draw = ImageDraw.Draw(mask)
    inset_x = int(base.width * 0.08)
    inset_y = int(base.height * 0.08)
    draw.ellipse((inset_x, inset_y, base.width - inset_x, base.height - inset_y), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(int(base.width * 0.22)))
    inv = Image.eval(mask, lambda p: max(0, opacity - int(p * opacity / 255)))
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    overlay.putalpha(inv)
    base.alpha_composite(overlay)


def trim_alpha(image: Image.Image) -> Image.Image:
    if image.mode != "RGBA":
        return image
    bbox = image.getchannel("A").getbbox()
    return image.crop(bbox) if bbox else image


def paste_wordmark(base: Image.Image, xy: tuple[int, int], width: int = 190) -> None:
    logo = trim_alpha(open_rgba(ASSETS / "thallo-logo-compact-white.png"))
    ratio = width / logo.width
    logo = logo.resize((width, int(logo.height * ratio)), Image.Resampling.LANCZOS)
    base.alpha_composite(logo, xy)


def paste_icon(base: Image.Image, xy: tuple[int, int], size: int) -> None:
    icon = open_rgba(ASSETS / "thallo-icon-mark.png").resize((size, size), Image.Resampling.LANCZOS)
    add_shadow(base, (xy[0], xy[1], xy[0] + size, xy[1] + size), radius=int(size * 0.2), blur=22, opacity=120, offset=(0, 10))
    paste_rounded(base, icon, xy, radius=int(size * 0.18))


def text_width(draw: ImageDraw.ImageDraw, value: str, fnt: ImageFont.FreeTypeFont) -> int:
    return int(draw.textbbox((0, 0), value, font=fnt)[2])


def wrap_text(draw: ImageDraw.ImageDraw, value: str, fnt: ImageFont.FreeTypeFont, max_width: int) -> list[str]:
    lines: list[str] = []
    for raw in value.split("\n"):
        words = raw.split()
        if not words:
            lines.append("")
            continue
        current = words[0]
        for word in words[1:]:
            candidate = f"{current} {word}"
            if text_width(draw, candidate, fnt) <= max_width:
                current = candidate
            else:
                lines.append(current)
                current = word
        lines.append(current)
    return lines


def draw_wrapped(
    draw: ImageDraw.ImageDraw,
    value: str,
    xy: tuple[int, int],
    fnt: ImageFont.FreeTypeFont,
    fill: tuple[int, int, int, int],
    max_width: int,
    line_gap: int,
) -> int:
    x, y = xy
    lines = wrap_text(draw, value, fnt, max_width)
    line_h = int(fnt.size * 1.08)
    for line in lines:
        draw.text((x, y), line, font=fnt, fill=fill)
        y += line_h + line_gap
    return y


def draw_chip(draw: ImageDraw.ImageDraw, xy: tuple[int, int], text: str, accent: str = "primary") -> int:
    fnt = font(25, FONT_DEMI)
    pad_x = 22
    pad_y = 12
    w = text_width(draw, text, fnt) + pad_x * 2
    h = 52
    x, y = xy
    fill = hex_to_rgba(COLORS["surface"], 218)
    outline = hex_to_rgba(COLORS[accent], 140)
    draw.rounded_rectangle((x, y, x + w, y + h), radius=26, fill=fill, outline=outline, width=2)
    draw.text((x + pad_x, y + pad_y - 1), text, font=fnt, fill=hex_to_rgba(COLORS["text"]))
    return w


def draw_stat_panel(
    base: Image.Image,
    xy: tuple[int, int],
    title: str,
    stats: list[tuple[str, str, str]],
    accent: str = "primary",
    width: int = 420,
) -> None:
    x, y = xy
    height = 150 + len(stats) * 2
    box = (x, y, x + width, y + height)
    add_shadow(base, box, radius=26, blur=24, opacity=115, offset=(0, 14))
    panel = Image.new("RGBA", (width, height), hex_to_rgba(COLORS["surface"], 228))
    pdraw = ImageDraw.Draw(panel)
    pdraw.rounded_rectangle((0, 0, width - 1, height - 1), radius=26, fill=hex_to_rgba(COLORS["surface"], 228), outline=hex_to_rgba(COLORS[accent], 130), width=2)
    pdraw.text((26, 22), title.upper(), font=font(19, FONT_BOLD), fill=hex_to_rgba(COLORS["muted"]))
    cursor_x = 26
    for label, value, color in stats:
        pdraw.rounded_rectangle((cursor_x, 64, cursor_x + 112, 124), radius=16, fill=hex_to_rgba("#06101B", 238), outline=hex_to_rgba(color, 145), width=1)
        pdraw.text((cursor_x + 14, 76), label.upper(), font=font(14, FONT_BOLD), fill=hex_to_rgba(COLORS["muted"]))
        pdraw.text((cursor_x + 14, 96), value, font=font(24, FONT_BOLD), fill=hex_to_rgba(COLORS["text"]))
        cursor_x += 124
    base.alpha_composite(panel, xy)


def make_phone(path: Path, target_height: int, rotate: float = 0) -> Image.Image:
    screen = open_rgba(path)
    ratio = target_height / screen.height
    screen = screen.resize((int(screen.width * ratio), target_height), Image.Resampling.LANCZOS)
    pad = max(14, int(target_height * 0.034))
    radius = max(28, int(target_height * 0.048))
    outer = Image.new("RGBA", (screen.width + pad * 2, screen.height + pad * 2), (0, 0, 0, 0))
    odraw = ImageDraw.Draw(outer)
    odraw.rounded_rectangle((0, 0, outer.width - 1, outer.height - 1), radius=radius + pad, fill=(4, 8, 13, 255), outline=(128, 248, 200, 56), width=2)
    paste_rounded(outer, screen, (pad, pad), radius=radius)
    glare = Image.new("RGBA", outer.size, (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glare)
    gdraw.rounded_rectangle((pad, pad, outer.width - pad, outer.height - pad), radius=radius, outline=(255, 255, 255, 24), width=2)
    outer.alpha_composite(glare)
    if rotate:
        outer = outer.rotate(rotate, expand=True, resample=Image.Resampling.BICUBIC)
    return outer


def make_watch(path: Path, target_width: int) -> Image.Image:
    screen = open_rgba(path)
    ratio = target_width / screen.width
    screen = screen.resize((target_width, int(screen.height * ratio)), Image.Resampling.LANCZOS)
    pad = int(target_width * 0.07)
    outer = Image.new("RGBA", (screen.width + pad * 2, screen.height + pad * 2), (0, 0, 0, 0))
    draw = ImageDraw.Draw(outer)
    radius = int(outer.width * 0.2)
    draw.rounded_rectangle((0, 0, outer.width - 1, outer.height - 1), radius=radius, fill=(3, 7, 12, 255), outline=(128, 248, 200, 70), width=2)
    paste_rounded(outer, screen, (pad, pad), radius=int(screen.width * 0.16))
    return outer


def paste_floating(base: Image.Image, image: Image.Image, xy: tuple[int, int], radius: int = 54) -> None:
    add_shadow(base, (xy[0], xy[1], xy[0] + image.width, xy[1] + image.height), radius=radius, blur=34, opacity=145, offset=(0, 22))
    base.alpha_composite(image, xy)


def base_photo(name: str, size: tuple[int, int], focus: tuple[float, float] = (0.5, 0.5)) -> Image.Image:
    image = crop_cover(open_rgba(ASSETS / "landing-photos" / name), size, focus)
    overlay_gradient(image, "vertical", 60, 185)
    add_vignette(image, opacity=135)
    return image


def draw_brand(base: Image.Image, x: int, y: int, logo_width: int = 180) -> None:
    paste_icon(base, (x, y - 5), 54)
    paste_wordmark(base, (x + 70, y + 10), logo_width)


def save(image: Image.Image, name: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    image.convert("RGB").save(OUT / name, quality=96, optimize=True)


def profile_pictures() -> None:
    board = open_rgba(ASSETS / "brand" / "thallo-brand-board-dark-source.png")
    top_mark = board.crop((402, 148, 852, 598))
    for name, size, icon_size in [
        ("thallo-instagram-profile-picture-1080x1080.png", 1080, 1080),
        ("thallo-instagram-profile-picture-320x320.png", 320, 320),
    ]:
        save(top_mark.resize((icon_size, icon_size), Image.Resampling.LANCZOS), name)


def feed_total_health() -> None:
    base = base_photo("pexels-crossfit-group-27433192.jpg", (1080, 1080), (0.48, 0.44))
    overlay_gradient(base, "horizontal", 210, 86)
    draw = ImageDraw.Draw(base)
    draw_brand(base, 70, 58)

    y = 188
    draw.text((72, y), "TOTAL HEALTH", font=font(24, FONT_BOLD), fill=hex_to_rgba(COLORS["primary_light"]))
    y += 52
    y = draw_wrapped(
        draw,
        "Training, meals, and recovery in one plan.",
        (70, y),
        font(62, FONT_BOLD),
        hex_to_rgba(COLORS["text"]),
        540,
        4,
    )
    y += 18
    draw_wrapped(
        draw,
        "Built around your real week: schedule, equipment, food preferences, and recovery signals.",
        (72, y),
        font(28, FONT_MEDIUM),
        hex_to_rgba(COLORS["muted"]),
        500,
        8,
    )
    chip_y = 875
    x = 70
    for label in ["Workout plan", "Macros", "Readiness"]:
        x += draw_chip(draw, (x, chip_y), label) + 12

    phone = make_phone(ASSETS / "product-screenshots" / "thallo-today-home-aurora.png", 720, rotate=-2)
    paste_floating(base, phone, (606, 164))
    save(base, "thallo-feed-01-total-health-1080x1080.png")


def feed_workouts() -> None:
    base = base_photo("pexels-training-woman-lift.jpg", (1080, 1080), (0.48, 0.5))
    overlay_gradient(base, "horizontal", 98, 218)
    draw = ImageDraw.Draw(base)
    draw_brand(base, 680, 58, logo_width=170)

    phone = make_phone(ASSETS / "product-screenshots" / "thallo-today-home-ember.png", 744, rotate=2)
    paste_floating(base, phone, (74, 192))

    y = 188
    draw.text((585, y), "TRAINING", font=font(24, FONT_BOLD), fill=hex_to_rgba(COLORS["primary_light"]))
    y += 52
    y = draw_wrapped(
        draw,
        "Stop guessing what to train today.",
        (585, y),
        font(58, FONT_BOLD),
        hex_to_rgba(COLORS["text"]),
        395,
        4,
    )
    y += 18
    draw_wrapped(
        draw,
        "A focused 7-day plan with workouts queued around your real life.",
        (587, y),
        font(27, FONT_MEDIUM),
        hex_to_rgba(COLORS["muted"]),
        380,
        7,
    )
    draw_stat_panel(
        base,
        (580, 765),
        "Today",
        [("Split", "Lower", COLORS["primary"]), ("Time", "54m", COLORS["accent"]), ("Moves", "5", COLORS["amber"])],
        width=420,
    )
    save(base, "thallo-feed-02-workout-plan-1080x1080.png")


def feed_macros() -> None:
    base = base_photo("meal-chicken-rice.jpg", (1080, 1080), (0.48, 0.52))
    overlay_gradient(base, "horizontal", 214, 74)
    draw = ImageDraw.Draw(base)
    draw_brand(base, 70, 58)

    y = 188
    draw.text((72, y), "NUTRITION", font=font(24, FONT_BOLD), fill=hex_to_rgba(COLORS["accent"]))
    y += 52
    y = draw_wrapped(
        draw,
        "Macros that connect to real food.",
        (70, y),
        font(60, FONT_BOLD),
        hex_to_rgba(COLORS["text"]),
        510,
        4,
    )
    y += 18
    draw_wrapped(
        draw,
        "Log meals, check your score, and keep hydration in view.",
        (72, y),
        font(28, FONT_MEDIUM),
        hex_to_rgba(COLORS["muted"]),
        485,
        8,
    )
    draw_stat_panel(
        base,
        (70, 772),
        "Macros today",
        [("Cal", "1,320", COLORS["accent"]), ("Protein", "118g", COLORS["primary"]), ("Water", "+8oz", COLORS["primary_light"])],
        accent="accent",
        width=440,
    )

    phone = make_phone(ASSETS / "product-screenshots" / "thallo-today-home-paper.png", 724, rotate=-1)
    paste_floating(base, phone, (618, 170))
    save(base, "thallo-feed-03-macros-1080x1080.png")


def feed_recovery() -> None:
    base = base_photo("pexels-smartwatch-couple-5038816.jpg", (1080, 1080), (0.42, 0.47))
    overlay_gradient(base, "horizontal", 206, 86)
    draw = ImageDraw.Draw(base)
    draw_brand(base, 70, 58)

    y = 188
    draw.text((72, y), "RECOVERY", font=font(24, FONT_BOLD), fill=hex_to_rgba(COLORS["primary_light"]))
    y += 52
    y = draw_wrapped(
        draw,
        "Know when to push. Know when to recover.",
        (70, y),
        font(57, FONT_BOLD),
        hex_to_rgba(COLORS["text"]),
        548,
        4,
    )
    y += 18
    draw_wrapped(
        draw,
        "Sleep, readiness, water, and progress signals on your phone and watch.",
        (72, y),
        font(28, FONT_MEDIUM),
        hex_to_rgba(COLORS["muted"]),
        500,
        8,
    )

    phone = make_phone(ASSETS / "product-screenshots" / "thallo-today-home-rose.png", 676, rotate=-4)
    paste_floating(base, phone, (594, 204))
    watch = make_watch(ASSETS / "product-screenshots" / "thallo-watch-today.png", 306)
    paste_floating(base, watch, (548, 640), radius=70)
    save(base, "thallo-feed-04-recovery-watch-1080x1080.png")


def story_start() -> None:
    base = base_photo("pexels-foadshariyati-31849600.jpg", (1080, 1920), (0.48, 0.5))
    overlay_gradient(base, "vertical", 82, 230)
    draw = ImageDraw.Draw(base)
    draw_brand(base, 72, 72, logo_width=210)
    draw.text((74, 228), "YOUR REAL WEEK", font=font(28, FONT_BOLD), fill=hex_to_rgba(COLORS["primary_light"]))
    draw_wrapped(
        draw,
        "Build the plan. Follow the day.",
        (70, 282),
        font(82, FONT_BOLD),
        hex_to_rgba(COLORS["text"]),
        830,
        5,
    )
    phone = make_phone(ASSETS / "product-screenshots" / "thallo-today-home-aurora.png", 1040, rotate=-2)
    paste_floating(base, phone, (472, 596))
    draw_chip(draw, (70, 1560), "Training | Nutrition | Recovery")
    draw.text((74, 1628), "THALLO", font=font(34, FONT_BOLD), fill=hex_to_rgba(COLORS["text"]))
    save(base, "thallo-story-01-real-week-1080x1920.png")


def story_meals() -> None:
    base = base_photo("meal-prep.jpg", (1080, 1920), (0.48, 0.54))
    overlay_gradient(base, "vertical", 92, 228)
    draw = ImageDraw.Draw(base)
    draw_brand(base, 72, 72, logo_width=210)
    draw.text((74, 234), "MEALS + MACROS", font=font(28, FONT_BOLD), fill=hex_to_rgba(COLORS["accent"]))
    draw_wrapped(
        draw,
        "Your nutrition, live.",
        (70, 290),
        font(86, FONT_BOLD),
        hex_to_rgba(COLORS["text"]),
        840,
        6,
    )
    draw_wrapped(
        draw,
        "Log meals. See the score. Adjust fast.",
        (74, 512),
        font(34, FONT_MEDIUM),
        hex_to_rgba(COLORS["muted"]),
        740,
        8,
    )
    phone = make_phone(ASSETS / "product-screenshots" / "thallo-today-home-paper.png", 1080, rotate=2)
    paste_floating(base, phone, (508, 696))
    draw_stat_panel(
        base,
        (72, 1358),
        "Macros today",
        [("Cal", "1,320", COLORS["accent"]), ("Protein", "118g", COLORS["primary"]), ("Water", "+8oz", COLORS["primary_light"])],
        accent="accent",
        width=500,
    )
    save(base, "thallo-story-02-nutrition-live-1080x1920.png")


def story_recovery() -> None:
    base = base_photo("pexels-smartwatch-couple-5038816-mobile.jpg", (1080, 1920), (0.46, 0.52))
    overlay_gradient(base, "vertical", 96, 238)
    draw = ImageDraw.Draw(base)
    draw_brand(base, 72, 72, logo_width=210)
    draw.text((74, 232), "PHONE + WATCH", font=font(28, FONT_BOLD), fill=hex_to_rgba(COLORS["primary_light"]))
    draw_wrapped(
        draw,
        "One glance before you lift.",
        (70, 288),
        font(82, FONT_BOLD),
        hex_to_rgba(COLORS["text"]),
        850,
        6,
    )
    draw_wrapped(
        draw,
        "Workout, macros, water, sleep, and readiness in the same daily view.",
        (74, 508),
        font(34, FONT_MEDIUM),
        hex_to_rgba(COLORS["muted"]),
        820,
        9,
    )
    phone = make_phone(ASSETS / "product-screenshots" / "thallo-today-home-rose.png", 1010, rotate=-4)
    paste_floating(base, phone, (150, 812))
    watch = make_watch(ASSETS / "product-screenshots" / "thallo-watch-today.png", 380)
    paste_floating(base, watch, (606, 1126), radius=86)
    draw_chip(draw, (72, 1608), "Readiness | Hydration | Progress")
    save(base, "thallo-story-03-phone-watch-1080x1920.png")


def make_readme() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    readme = OUT / "README.md"
    readme.write_text(
        "\n".join(
            [
                "# Thallo Instagram Promo Pack",
                "",
                "Generated from first-party Thallo screenshots and local landing photo assets.",
                "",
                "## Profile picture",
                "- thallo-instagram-profile-picture-1080x1080.png",
                "- thallo-instagram-profile-picture-320x320.png",
                "",
                "## Feed / carousel posts",
                "- thallo-feed-01-total-health-1080x1080.png",
                "- thallo-feed-02-workout-plan-1080x1080.png",
                "- thallo-feed-03-macros-1080x1080.png",
                "- thallo-feed-04-recovery-watch-1080x1080.png",
                "",
                "## Story frames",
                "- thallo-story-01-real-week-1080x1920.png",
                "- thallo-story-02-nutrition-live-1080x1920.png",
                "- thallo-story-03-phone-watch-1080x1920.png",
                "",
                "## Caption starters",
                "- Your plan should know your schedule, equipment, meals, and recovery. Thallo brings training, nutrition, and readiness into one daily view.",
                "- Stop guessing what to train today. Thallo turns your real week into a focused plan you can actually follow.",
                "- Macros are easier when they live next to your workouts, water, sleep, and readiness.",
                "",
                "Source photo licensing is documented in assets/images/landing-photos/SOURCES.md.",
                "",
            ]
        ),
        encoding="utf-8",
    )


def main() -> None:
    profile_pictures()
    feed_total_health()
    feed_workouts()
    feed_macros()
    feed_recovery()
    story_start()
    story_meals()
    story_recovery()
    make_readme()


if __name__ == "__main__":
    main()
