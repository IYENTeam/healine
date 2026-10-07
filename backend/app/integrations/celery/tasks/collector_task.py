from typing import Any

from celery import shared_task

from app.database import SessionLocal
from app.repositories.collector_repository import collector_repository
from app.services.collector_service import collector_service


@shared_task(name="app.integrations.celery.tasks.collector_task.retry_collector_batches")
def retry_collector_batches() -> dict[str, Any]:
    """Recover raw responses accepted before a crash or a transient database error."""
    processed = 0
    with SessionLocal() as db:
        for batch_id in collector_repository.pending(db):
            result = collector_service.process(db, batch_id)
            processed += result.status in {"processed", "empty"}
    return {"processed": processed}
