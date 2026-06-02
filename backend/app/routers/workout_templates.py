"""Workout Templates — user-authored reusable single-day workouts.

Backed by the WorkoutTemplate table. The mobile cache (AsyncStorage key
`workoutTemplates`) is now a hot cache only; this router is the source of
truth.

Sharing model: each template can hold one optional `share_code` (6-char
ambiguity-stripped uppercase). When a recipient calls /shared/{code}/import
the row is COPIED into a fresh template owned by the recipient. Deleting
or revoking the original never affects already-imported copies.
"""
from __future__ import annotations

import secrets
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from app.auth import get_current_user
from app.database import get_session
from app.entitlements import FREE_WORKOUT_TEMPLATE_LIMIT, is_pro
from app.models import (
    User,
    UserProfile,
    WorkoutTemplate,
    WorkoutTemplateBundle,
    WorkoutTemplateBundleItem,
)


router = APIRouter(prefix="/workouts/templates", tags=["workouts"])


SHARE_CODE_LENGTH = 6
# Bundle codes use the same alphabet but a longer length so the API path
# can disambiguate by length without a marker char ("ABC234" → template,
# "ABC23456" → bundle). Eight chars also keeps the keyspace generous as
# bundle adoption grows.
BUNDLE_CODE_LENGTH = 8
# Cap how many templates can ride in one bundle. The number is arbitrary
# but bounded — large enough to cover any realistic library, small enough
# to keep import payloads + transactions manageable.
MAX_BUNDLE_ITEMS = 25
# Ambiguity-stripped: no 0/O, 1/I/L. Keeps codes easy to read aloud + type.
_SHARE_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"


def _generate_share_code(db: Session, *, length: int = SHARE_CODE_LENGTH) -> str:
    """Pick a random code that's not already taken. Collisions are rare
    (32^6 ≈ 1B) but we retry to be safe; growing length after many misses
    keeps generation bounded even on a saturated alphabet."""
    for attempt in range(12):
        code = "".join(secrets.choice(_SHARE_CODE_ALPHABET) for _ in range(length))
        existing = db.exec(
            select(WorkoutTemplate.id).where(WorkoutTemplate.share_code == code)
        ).first()
        if existing is None:
            return code
        if attempt == 6:
            length += 1
    raise HTTPException(status_code=500, detail="Could not allocate share code")


def _generate_bundle_code(db: Session, *, length: int = BUNDLE_CODE_LENGTH) -> str:
    """Bundle-code variant of `_generate_share_code`. Lives in its own
    namespace (workout_template_bundles.share_code) so a per-template
    code and a bundle code can collide on string value without
    collision in routing — the path differentiates them."""
    for attempt in range(12):
        code = "".join(secrets.choice(_SHARE_CODE_ALPHABET) for _ in range(length))
        existing = db.exec(
            select(WorkoutTemplateBundle.id).where(WorkoutTemplateBundle.share_code == code)
        ).first()
        if existing is None:
            return code
        if attempt == 6:
            length += 1
    raise HTTPException(status_code=500, detail="Could not allocate bundle code")


def _serialize(t: WorkoutTemplate, *, include_owner_username: str | None = None) -> dict:
    out: dict[str, Any] = {
        "id": t.client_id,
        "name": t.name,
        "notes": t.notes,
        "workout": t.workout_json or {},
        "shareCode": t.share_code,
        "timesImported": t.times_imported,
        "sourceShareCode": t.source_share_code,
        # Attribution: snapshot of the owner's username at import time.
        # Survives share-code revocation + owner username changes.
        "sourceOwnerUsername": t.source_owner_username,
        "createdAt": (t.created_at or datetime.now(timezone.utc)).isoformat(),
        "updatedAt": (t.updated_at or datetime.now(timezone.utc)).isoformat(),
    }
    if include_owner_username is not None:
        out["ownerUsername"] = include_owner_username
    return out


def _get_owned_template(
    db: Session, user_id: int, client_id: str
) -> WorkoutTemplate:
    if not client_id:
        raise HTTPException(status_code=400, detail="template id required")
    row = db.exec(
        select(WorkoutTemplate)
        .where(WorkoutTemplate.user_id == user_id)
        .where(WorkoutTemplate.client_id == client_id)
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Template not found")
    return row


def _user_template_limit(user: User | None) -> int | None:
    """Returns None for unlimited (Pro), else the integer cap."""
    return None if is_pro(user) else FREE_WORKOUT_TEMPLATE_LIMIT


def _enforce_template_cap(
    db: Session, user: User, *, importing: bool = False
) -> None:
    cap = _user_template_limit(user)
    if cap is None:
        return
    count = db.exec(
        select(WorkoutTemplate.id).where(WorkoutTemplate.user_id == user.id)
    ).all()
    if len(count) >= cap:
        msg = (
            f"Free accounts can save up to {cap} workout templates. "
            "Upgrade to Pro for unlimited."
        )
        if importing:
            msg = (
                f"You're at the {cap}-template limit. Delete one before "
                "importing this template, or upgrade to Pro."
            )
        raise HTTPException(status_code=403, detail=msg)


# ─── CRUD ────────────────────────────────────────────────────────────────────

class TemplateUpsertBody(BaseModel):
    id: str
    name: str
    workout: dict
    notes: str | None = None
    createdAt: str | None = None
    updatedAt: str | None = None


@router.get("")
def list_templates(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    rows = db.exec(
        select(WorkoutTemplate)
        .where(WorkoutTemplate.user_id == current_user.id)
        .order_by(WorkoutTemplate.updated_at.desc())
    ).all()
    return [_serialize(r) for r in rows]


@router.post("", status_code=201)
def create_template(
    body: TemplateUpsertBody,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    if not body.id or not body.name.strip():
        raise HTTPException(status_code=400, detail="id and name required")

    # Idempotent on (user_id, client_id) — repeat creates from a flaky
    # network are treated as updates, matching the mobile cache's expectation.
    existing = db.exec(
        select(WorkoutTemplate)
        .where(WorkoutTemplate.user_id == current_user.id)
        .where(WorkoutTemplate.client_id == body.id)
    ).first()
    if existing is not None:
        existing.name = body.name.strip()
        existing.notes = body.notes
        existing.workout_json = body.workout or {}
        existing.updated_at = datetime.now(timezone.utc)
        db.add(existing)
        db.commit()
        db.refresh(existing)
        return _serialize(existing)

    _enforce_template_cap(db, current_user)

    now = datetime.now(timezone.utc)
    row = WorkoutTemplate(
        user_id=current_user.id,
        client_id=body.id,
        name=body.name.strip(),
        notes=body.notes,
        workout_json=body.workout or {},
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _serialize(row)


@router.put("/{template_id}")
def update_template(
    template_id: str,
    body: TemplateUpsertBody,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    row = _get_owned_template(db, current_user.id, template_id)
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="name required")
    row.name = body.name.strip()
    row.notes = body.notes
    row.workout_json = body.workout or {}
    row.updated_at = datetime.now(timezone.utc)
    db.add(row)
    db.commit()
    db.refresh(row)
    return _serialize(row)


@router.delete("/{template_id}", status_code=204)
def delete_template(
    template_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    row = _get_owned_template(db, current_user.id, template_id)
    db.delete(row)
    db.commit()
    return None


# ─── Share / Import ──────────────────────────────────────────────────────────

@router.post("/{template_id}/share")
def share_template(
    template_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    row = _get_owned_template(db, current_user.id, template_id)
    if not row.share_code:
        row.share_code = _generate_share_code(db)
        row.updated_at = datetime.now(timezone.utc)
        db.add(row)
        db.commit()
        db.refresh(row)
    return {"shareCode": row.share_code, "template": _serialize(row)}


@router.delete("/{template_id}/share", status_code=204)
def revoke_share(
    template_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    row = _get_owned_template(db, current_user.id, template_id)
    if row.share_code:
        row.share_code = None
        row.updated_at = datetime.now(timezone.utc)
        db.add(row)
        db.commit()
    return None


def _normalize_code(code: str) -> str:
    return (code or "").strip().upper()


def _lookup_by_code(db: Session, code: str) -> WorkoutTemplate:
    code = _normalize_code(code)
    if not code:
        raise HTTPException(status_code=400, detail="share code required")
    row = db.exec(
        select(WorkoutTemplate).where(WorkoutTemplate.share_code == code)
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Template not found for that code")
    return row


@router.get("/shared/{code}")
def preview_shared(
    code: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    row = _lookup_by_code(db, code)
    owner = db.get(User, row.user_id)
    return _serialize(
        row,
        include_owner_username=(owner.username if owner else None),
    )


class ImportBody(BaseModel):
    # Client-assigned uuid for the new (recipient-owned) row, so the local
    # cache and server stay in sync from the moment of import.
    clientId: str


def _import_shared_template(
    db: Session,
    *,
    recipient: User,
    source: WorkoutTemplate,
    code: str,
    client_id: str,
    enforce_cap: bool = True,
) -> tuple[WorkoutTemplate, bool]:
    """Shared import body — used by both the single-template and bundle
    import endpoints. Returns (template, created). `created` is False
    when an idempotent re-import returned the existing copy.

    The caller commits. Cap enforcement is opt-in so the bundle path can
    short-circuit the whole transaction with a single up-front check
    rather than failing partway through.
    """
    if not client_id:
        raise HTTPException(status_code=400, detail="clientId required")
    code_norm = _normalize_code(code)

    existing = db.exec(
        select(WorkoutTemplate)
        .where(WorkoutTemplate.user_id == recipient.id)
        .where(WorkoutTemplate.source_share_code == code_norm)
    ).first()
    if existing is not None:
        return existing, False

    if enforce_cap:
        _enforce_template_cap(db, recipient, importing=True)

    owner = db.get(User, source.user_id)
    owner_username = owner.username if owner else None

    now = datetime.now(timezone.utc)
    copy = WorkoutTemplate(
        user_id=recipient.id,
        client_id=client_id,
        name=source.name,
        notes=source.notes,
        workout_json=dict(source.workout_json or {}),
        share_code=None,                # imported copies are private by default
        source_share_code=code_norm,
        source_owner_username=owner_username,
        created_at=now,
        updated_at=now,
    )
    db.add(copy)

    source.times_imported = (source.times_imported or 0) + 1
    db.add(source)
    return copy, True


@router.post("/shared/{code}/import", status_code=201)
def import_shared(
    code: str,
    body: ImportBody,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    source = _lookup_by_code(db, code)
    if source.user_id == current_user.id:
        raise HTTPException(
            status_code=400, detail="You already own this template"
        )
    copy, _ = _import_shared_template(
        db,
        recipient=current_user,
        source=source,
        code=code,
        client_id=body.clientId,
    )
    db.commit()
    db.refresh(copy)
    return _serialize(copy)


# ─── Bundles (multi-template share / import) ────────────────────────────────
#
# Layered on top of per-template share codes: a bundle is just a named
# collection of share codes. Creating a bundle auto-mints share codes for
# any included template that doesn't have one, then mints a bundle code so
# the recipient can preview + import the whole set in one round trip.
#
# Items are stored as snapshots of share_code, not FKs into
# workout_templates — so the bundle survives owner-side template deletes
# and share-code revocations (those items just show as "unavailable" on
# the recipient side).


def _lookup_bundle_by_code(db: Session, code: str) -> WorkoutTemplateBundle:
    code = _normalize_code(code)
    if not code:
        raise HTTPException(status_code=400, detail="bundle code required")
    row = db.exec(
        select(WorkoutTemplateBundle).where(WorkoutTemplateBundle.share_code == code)
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Bundle not found for that code")
    return row


def _bundle_owned_templates(
    db: Session, user_id: int, client_ids: list[str]
) -> list[WorkoutTemplate]:
    """Resolve the caller-supplied client_ids to owned templates,
    preserving caller order. Raises 400 if any id isn't owned by the
    caller — keeps the bundle scoped to the user's own library."""
    if not client_ids:
        raise HTTPException(status_code=400, detail="templateIds required")
    if len(client_ids) > MAX_BUNDLE_ITEMS:
        raise HTTPException(
            status_code=400,
            detail=f"Bundles can hold up to {MAX_BUNDLE_ITEMS} templates.",
        )
    rows = db.exec(
        select(WorkoutTemplate)
        .where(WorkoutTemplate.user_id == user_id)
        .where(WorkoutTemplate.client_id.in_(client_ids))  # type: ignore[attr-defined]
    ).all()
    by_id = {r.client_id: r for r in rows}
    ordered: list[WorkoutTemplate] = []
    missing: list[str] = []
    for cid in client_ids:
        row = by_id.get(cid)
        if row is None:
            missing.append(cid)
        else:
            ordered.append(row)
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Templates not found or not owned: {', '.join(missing)}",
        )
    return ordered


class BundleCreateBody(BaseModel):
    name: str = ""
    templateIds: list[str]


@router.post("/bundles", status_code=201)
def create_bundle(
    body: BundleCreateBody,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    templates = _bundle_owned_templates(db, current_user.id, body.templateIds)

    # Auto-mint share codes for any template in the bundle that doesn't
    # have one yet. The recipient resolves each item by share_code, so
    # private templates are unreachable through a bundle without this.
    for t in templates:
        if not t.share_code:
            t.share_code = _generate_share_code(db)
            t.updated_at = datetime.now(timezone.utc)
            db.add(t)

    bundle = WorkoutTemplateBundle(
        user_id=current_user.id,
        name=(body.name or "").strip()[:120],
        share_code=_generate_bundle_code(db),
    )
    db.add(bundle)
    db.flush()  # pull bundle.id for items

    for pos, t in enumerate(templates):
        db.add(WorkoutTemplateBundleItem(
            bundle_id=bundle.id,
            share_code=t.share_code,
            position=pos,
        ))

    db.commit()
    db.refresh(bundle)
    return _serialize_bundle(db, bundle, current_user)


def _serialize_bundle(
    db: Session,
    bundle: WorkoutTemplateBundle,
    viewer: User | None,
) -> dict:
    """Bundle response shape. Items are inlined as preview-shaped rows so
    one round trip carries everything the import sheet needs to render."""
    item_rows = db.exec(
        select(WorkoutTemplateBundleItem)
        .where(WorkoutTemplateBundleItem.bundle_id == bundle.id)
        .order_by(WorkoutTemplateBundleItem.position)
    ).all()
    items: list[dict] = []
    for it in item_rows:
        t = db.exec(
            select(WorkoutTemplate).where(WorkoutTemplate.share_code == it.share_code)
        ).first()
        if t is None:
            # Underlying template was deleted or had its share code
            # revoked; surface a tombstone row so the UI can grey it out.
            items.append({
                "shareCode": it.share_code,
                "available": False,
                "name": None,
                "workout": None,
                "ownerUsername": None,
            })
            continue
        owner = db.get(User, t.user_id)
        items.append({
            "shareCode": it.share_code,
            "available": True,
            "name": t.name,
            "notes": t.notes,
            "workout": t.workout_json or {},
            "ownerUsername": owner.username if owner else None,
        })

    bundle_owner = db.get(User, bundle.user_id)
    return {
        "bundleCode": bundle.share_code,
        "name": bundle.name,
        "ownerUsername": bundle_owner.username if bundle_owner else None,
        "ownedByViewer": viewer is not None and viewer.id == bundle.user_id,
        "timesImported": bundle.times_imported,
        "items": items,
        "createdAt": (bundle.created_at or datetime.now(timezone.utc)).isoformat(),
        "updatedAt": (bundle.updated_at or datetime.now(timezone.utc)).isoformat(),
    }


@router.get("/bundles/shared/{code}")
def preview_shared_bundle(
    code: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    bundle = _lookup_bundle_by_code(db, code)
    return _serialize_bundle(db, bundle, current_user)


class BundleImportItem(BaseModel):
    shareCode: str
    clientId: str


class BundleImportBody(BaseModel):
    items: list[BundleImportItem]


@router.post("/bundles/shared/{code}/import", status_code=201)
def import_shared_bundle(
    code: str,
    body: BundleImportBody,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    bundle = _lookup_bundle_by_code(db, code)
    if bundle.user_id == current_user.id:
        raise HTTPException(
            status_code=400, detail="You already own this bundle"
        )
    if not body.items:
        raise HTTPException(status_code=400, detail="items required")
    if len(body.items) > MAX_BUNDLE_ITEMS:
        raise HTTPException(
            status_code=400,
            detail=f"Bundles can hold up to {MAX_BUNDLE_ITEMS} templates.",
        )

    # Constrain selection to codes that are actually in the bundle, so a
    # caller can't repurpose this endpoint to import arbitrary share codes
    # in bulk and bypass the per-bundle owner attribution.
    bundle_codes = {
        r.share_code for r in db.exec(
            select(WorkoutTemplateBundleItem)
            .where(WorkoutTemplateBundleItem.bundle_id == bundle.id)
        ).all()
    }
    bad = [i.shareCode for i in body.items if _normalize_code(i.shareCode) not in bundle_codes]
    if bad:
        raise HTTPException(
            status_code=400,
            detail=f"Items not in bundle: {', '.join(bad)}",
        )

    # Pre-flight cap check: count fresh imports (items the recipient
    # doesn't already own via source_share_code). The single-import path
    # raises mid-loop; bundles need an all-or-nothing read so a partial
    # import can't leave the user wedged at the cap with no clean undo.
    cap = _user_template_limit(current_user)
    if cap is not None:
        already_owned_codes = {
            r.source_share_code for r in db.exec(
                select(WorkoutTemplate)
                .where(WorkoutTemplate.user_id == current_user.id)
                .where(WorkoutTemplate.source_share_code.in_(  # type: ignore[attr-defined]
                    [_normalize_code(i.shareCode) for i in body.items]
                ))
            ).all()
        }
        new_imports = [i for i in body.items if _normalize_code(i.shareCode) not in already_owned_codes]
        current_count = len(db.exec(
            select(WorkoutTemplate.id).where(WorkoutTemplate.user_id == current_user.id)
        ).all())
        if current_count + len(new_imports) > cap:
            raise HTTPException(
                status_code=403,
                detail=(
                    f"This bundle would put you {current_count + len(new_imports) - cap} "
                    f"over the {cap}-template limit. Upgrade to Pro or import fewer."
                ),
            )

    imported: list[dict] = []
    skipped: list[dict] = []
    for item in body.items:
        source = db.exec(
            select(WorkoutTemplate).where(WorkoutTemplate.share_code == _normalize_code(item.shareCode))
        ).first()
        if source is None:
            skipped.append({"shareCode": item.shareCode, "reason": "not_found"})
            continue
        if source.user_id == current_user.id:
            skipped.append({"shareCode": item.shareCode, "reason": "already_owner"})
            continue
        copy, _created = _import_shared_template(
            db,
            recipient=current_user,
            source=source,
            code=item.shareCode,
            client_id=item.clientId,
            enforce_cap=False,  # already pre-flighted above
        )
        # `copy` is the SQLModel row; serialize lazily after commit so the
        # response reflects committed state.
        imported.append({"row": copy, "shareCode": item.shareCode})

    bundle.times_imported = (bundle.times_imported or 0) + 1
    bundle.updated_at = datetime.now(timezone.utc)
    db.add(bundle)
    db.commit()

    return {
        "bundleCode": bundle.share_code,
        "imported": [_serialize(i["row"]) for i in imported],
        "skipped": skipped,
    }
