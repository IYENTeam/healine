"""Guard: the retired `energy` spelling keeps working until the 1.0 cut."""

import pytest

from app.constants.webhooks.events import SERIES_TYPE_TO_GRANULAR_EVENT, SERIES_TYPE_TO_GROUP_EVENT
from app.schemas.enums import SeriesType, get_series_type_id, retired_series_type_name


class TestRetiredSeriesTypeNames:
    def test_retired_name_resolves_to_the_current_member(self) -> None:
        assert SeriesType("energy") is SeriesType.active_energy
        assert SeriesType("active_energy") is SeriesType.active_energy

    def test_both_spellings_share_the_stored_id(self) -> None:
        """The id is what rows reference, so the rename must not move it."""
        assert get_series_type_id(SeriesType("energy")) == 81

    def test_responses_carry_the_current_name(self) -> None:
        """The alias is lookup-only; nothing should serialize the retired spelling back."""
        assert SeriesType("energy").value == "active_energy"

    def test_unknown_names_are_still_rejected(self) -> None:
        with pytest.raises(ValueError, match="not a valid SeriesType"):
            SeriesType("not_a_series_type")

    def test_webhook_maps_answer_to_both_spellings(self) -> None:
        """A missing key makes the emitter return without firing, so this fails silently."""
        for mapping in (SERIES_TYPE_TO_GROUP_EVENT, SERIES_TYPE_TO_GRANULAR_EVENT):
            assert mapping["active_energy"] == mapping["energy"]

    def test_webhook_payload_keeps_the_retired_name(self) -> None:
        """Subscribers are push-only and cannot ask for a vocabulary, so they keep the old one."""
        assert retired_series_type_name("active_energy") == "energy"
        assert retired_series_type_name("steps") == "steps"
