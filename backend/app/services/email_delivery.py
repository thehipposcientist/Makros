"""Transactional email delivery for auth flows.

Configured with SMTP_* environment variables so production can use SES,
Postmark SMTP, SendGrid SMTP, or any equivalent provider without coupling
the app to a vendor SDK.
"""
from __future__ import annotations

import os
import smtplib
import ssl
from email.message import EmailMessage
from urllib.parse import urlencode

from app.logging_setup import get_logger

logger = get_logger("app.email")


def _configured() -> bool:
    return bool(os.getenv("SMTP_HOST") and os.getenv("SMTP_FROM_EMAIL"))


def _auth_link(kind: str, email: str, token: str) -> str:
    template_env = "EMAIL_VERIFICATION_URL_TEMPLATE" if kind == "verify" else "PASSWORD_RESET_URL_TEMPLATE"
    template = os.getenv(template_env)
    if template:
        return template.format(email=email, token=token)
    query = urlencode({"email": email, "token": token})
    path = "verify-email" if kind == "verify" else "reset-password"
    return f"thallo://{path}?{query}"


def send_transactional_email(to_email: str, subject: str, text_body: str) -> bool:
    if not _configured():
        logger.warning("email_delivery_not_configured", extra={"to": to_email, "subject": subject})
        return False

    host = os.getenv("SMTP_HOST", "")
    port = int(os.getenv("SMTP_PORT", "587"))
    username = os.getenv("SMTP_USERNAME")
    password = os.getenv("SMTP_PASSWORD")
    from_email = os.getenv("SMTP_FROM_EMAIL", "")
    from_name = os.getenv("SMTP_FROM_NAME", "Thallo")
    use_ssl = os.getenv("SMTP_USE_SSL", "0") == "1"
    use_tls = os.getenv("SMTP_USE_TLS", "1") != "0"
    timeout = float(os.getenv("SMTP_TIMEOUT_SECONDS", "10"))

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = f"{from_name} <{from_email}>"
    msg["To"] = to_email
    msg.set_content(text_body)

    try:
        if use_ssl:
            with smtplib.SMTP_SSL(host, port, timeout=timeout, context=ssl.create_default_context()) as smtp:
                if username and password:
                    smtp.login(username, password)
                smtp.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=timeout) as smtp:
                if use_tls:
                    smtp.starttls(context=ssl.create_default_context())
                if username and password:
                    smtp.login(username, password)
                smtp.send_message(msg)
        logger.info("email_delivery_ok", extra={"to": to_email, "subject": subject})
        return True
    except Exception:
        logger.exception("email_delivery_failed", extra={"to": to_email, "subject": subject})
        return False


def send_verification_email(to_email: str, token: str) -> bool:
    link = _auth_link("verify", to_email, token)
    body = (
        "Verify your Thallo email\n\n"
        f"Open this link to verify your email:\n{link}\n\n"
        f"Verification code: {token}\n\n"
        "This link expires in 30 minutes. If you did not request it, you can ignore this email."
    )
    return send_transactional_email(to_email, "Verify your Thallo email", body)


def send_password_reset_email(to_email: str, token: str) -> bool:
    link = _auth_link("reset", to_email, token)
    body = (
        "Reset your Thallo password\n\n"
        f"Open this link to reset your password:\n{link}\n\n"
        f"Reset code: {token}\n\n"
        "This link expires in 30 minutes. If you did not request it, you can ignore this email."
    )
    return send_transactional_email(to_email, "Reset your Thallo password", body)
