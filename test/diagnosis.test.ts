import * as assert from 'assert';
import {
  diagnoseError,
  isImagePullError,
  isImageCatalogLimitError
} from '../src/util/diagnosis';

describe('Error Diagnostics (§5 Table Mapping)', () => {
  it('should diagnose 502 box unreachable errors', () => {
    const diag = diagnoseError('502 box unreachable from proxy');
    assert.strictEqual(diag.summary.includes('502'), true);
    assert.strictEqual(diag.checklist.some((item) => item.includes('0.0.0.0')), true);
  });

  it('should diagnose 401 unauthorized / invalid credentials errors', () => {
    const diag = diagnoseError('HTTP 401: Invalid credentials');
    assert.strictEqual(diag.summary.includes('401'), true);
    assert.strictEqual(diag.checklist.some((item) => item.includes('BOXLITE_API_KEY')), true);
  });

  it('should diagnose 403 forbidden / login errors', () => {
    const diag = diagnoseError('BoxLite Cloud API Error (403): Forbidden resource');
    assert.strictEqual(diag.summary.includes('403'), true);
    assert.strictEqual(diag.checklist.some((item) => item.includes('agent.md §5')), true);
    assert.strictEqual(diag.checklist.some((item) => item.includes('shared-volume support')), true);
  });

  it('should diagnose 409 conflict errors', () => {
    const diag = diagnoseError('409 Conflict: box name already exists');
    assert.strictEqual(diag.summary.includes('409'), true);
  });

  it('should diagnose NetworkError', () => {
    const diag = diagnoseError('Connection failed', 'NetworkError');
    assert.strictEqual(diag.summary.includes('Network Error'), true);
    assert.strictEqual(diag.checklist.some((item) => item.includes('BOXLITE_REST_URL')), true);
  });

  it('should diagnose 400 bad request / schema validation errors', () => {
    const diag = diagnoseError('BoxLite Cloud API error (400): property auto_remove should not exist');
    assert.strictEqual(diag.summary.includes('400'), true);
    assert.strictEqual(diag.checklist.some((item) => item.includes('auto_remove')), true);
  });

  it('should diagnose box networking disabled (400 unsupported) without misattributing to auto_remove', () => {
    const diag = diagnoseError('BoxLite Cloud API error (400): unsupported: box networking is disabled');
    assert.strictEqual(diag.summary, 'Box Networking Permanently Disabled (No Guest NIC)');
    assert.strictEqual(diag.checklist.some((item) => item.includes('auto_remove')), false);
    assert.strictEqual(diag.checklist.some((item) => item.includes('Create Box with Options')), true);
  });

  it('should diagnose proxy TLS CA certificate verification failures', () => {
    const diag = diagnoseError('SSL: CERTIFICATE_VERIFY_FAILED against ca-certificates.crt');
    assert.strictEqual(diag.summary.includes('TLS Certificate Verification Failed'), true);
    assert.strictEqual(
      diag.checklist.some((item) => item.includes('/etc/ssl/certs/ca-certificates.crt')),
      true
    );
  });

  it('should diagnose missing headers mapping on Secret', () => {
    const diag = diagnoseError('Secret headers mapping is missing');
    assert.strictEqual(diag.summary.includes('Missing Required Headers Mapping'), true);
    assert.strictEqual(
      diag.checklist.some((item) => item.includes('<BOXLITE_SECRET:name>')),
      true
    );
  });

  it('should diagnose outbound secret proxy injection failures', () => {
    const diag = diagnoseError('Outbound BOXLITE_SECRET injection failed for target hostname');
    assert.strictEqual(diag.summary.includes('Secret Proxy Injection Diagnosis'), true);
    assert.strictEqual(
      diag.checklist.some((item) => item.includes('Secret.hosts')),
      true
    );
  });

  it('should diagnose image pull UNAUTHORIZED failures without misattributing to BOXLITE_API_KEY 401', () => {
    const msg =
      "Box state transition failed: Failed to pull image 'acme/api:1.4.0': docker.io refused the pull (UNAUTHORIZED). The image is private or does not exist, and no registry login of the organization covers it.";
    assert.strictEqual(isImagePullError(msg), true);

    const diag = diagnoseError(msg);
    assert.strictEqual(diag.summary, 'Image Pull Failed');
    assert.strictEqual(diag.checklist.some((item) => item.includes('BOXLITE_API_KEY')), false);
    assert.ok(diag.checklist[0].includes('typos'));
    assert.ok(diag.checklist[1].includes('Connect Private Registry'));
    assert.ok(diag.checklist[2].includes('tag'));
    assert.ok(diag.checklist[3].includes('box name passed to create()'));
  });

  it('should diagnose image catalog 20-image limit errors', () => {
    const msg = 'Organization image catalog limit reached (20 images maximum)';
    assert.strictEqual(isImageCatalogLimitError(msg), true);
    const diag = diagnoseError(msg);
    assert.strictEqual(diag.summary, 'Image Catalog Limit Reached (20 images)');
  });

  it('should diagnose per-box resource limit errors without misattributing to auto_remove', () => {
    const msg =
      'BoxLite Cloud API error (400): Requested resources exceed per-box limits: disk 20GB exceeds the per-box limit of 10GB';
    const diag = diagnoseError(msg);
    assert.strictEqual(diag.summary, 'Requested Resources Exceed Per-Box Limits');
    assert.strictEqual(diag.checklist.some((item) => item.includes('10 GB')), true);
    assert.strictEqual(diag.checklist.some((item) => item.includes('auto_remove')), false);
  });

  it('should diagnose BoxLite Cloud domain error codes accurately', () => {
    assert.strictEqual(
      diagnoseError('BoxLite Cloud API error (404) [domain_not_owned]: This organization does not own foo.boxliteapp.com.')
        .summary,
      'Domain Not Owned by Organization'
    );
    assert.strictEqual(
      diagnoseError('BoxLite Cloud API error (400) [domain_count_limit_reached]: Limit reached').summary,
      'Organization Domain Allowance Reached'
    );
    assert.strictEqual(
      diagnoseError('BoxLite Cloud API error (400) [subdomain_too_short]: Too short').summary,
      'Platform Subdomain Too Short'
    );
    assert.strictEqual(
      diagnoseError('BoxLite Cloud API error (409) [subdomain_taken]: Taken').summary,
      'Platform Subdomain Already Taken'
    );
    assert.strictEqual(
      diagnoseError('BoxLite Cloud API error (400) [region_not_supported]: Unsupported region').summary,
      'Region Not Supported for Platform Subdomain'
    );
    assert.strictEqual(
      diagnoseError('BoxLite Cloud API error (400) [platform_domain_not_configured]: Not configured').summary,
      'Platform Domains Not Configured on Server'
    );
    assert.strictEqual(
      diagnoseError('BoxLite Cloud API error (409) [domain_not_ready]: Complete custom domain setup').summary,
      'Custom Domain Setup or Subscription Incomplete'
    );
  });
});
