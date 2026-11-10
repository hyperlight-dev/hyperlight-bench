/*
 * hl_dummydriver: the hluk-dummy guest. It serves every guest function
 * call with the redirected request and runs no code, so it measures what
 * hyperlight-unikraft itself costs per call, as hyperlight-dummy does for
 * Hyperlight.
 *
 * hl_driver.h and hl_fc.h are hyperlight-unikraft's driver headers, copied
 * from its v0.16.0 tag (drivers/): the device protocol this driver speaks
 * must match the kernel embedded in hyperlight-unikraft 0.16.0.
 */

#include "hl_driver.h"

static const char REDIRECTED[] = "{\"uri\":\"/redirected.html\"}";

static int dispatch(const uint8_t *fc, size_t fc_len)
{
	if (fc_name_is(fc, fc_len, "Call"))
		return hl_set_result(REDIRECTED, sizeof(REDIRECTED) - 1) < 0 ? -1 : 0;
	/* Exec and GuestExec: there is nothing to load. */
	return 0;
}

int main(void)
{
	if (hl_driver_init("hl_dummydriver"))
		return 1;
	hl_driver_serve_calls();
	hl_driver_run(dispatch);
}
