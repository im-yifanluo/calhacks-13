# 4DGaussians config for a Memory Replay clip (based on arguments/hypernerf/default.py).
# Changes: finer multires (scene is ~13 m across, metres), colour deformation on (stage lights / auto-exposure),
# light SSIM term, no per-100-iteration training renders.
ModelHiddenParams = dict(
    kplanes_config = {
     'grid_dimensions': 2,
     'input_coordinate_dim': 4,
     'output_coordinate_dim': 16,
     'resolution': [64, 64, 64, 300]
    },
    multires = [1, 2, 4, 8],
    defor_depth = 1,
    net_width = 128,
    plane_tv_weight = 0.0002,
    time_smoothness_weight = 0.001,
    l1_time_planes = 0.0001,
    no_dshs = False,
    render_process = False,
)
OptimizationParams = dict(
    iterations = 18_000,
    batch_size = 2,
    coarse_iterations = 3000,
    densify_until_iter = 12_000,
    opacity_reset_interval = 300000,
    lambda_dssim = 0.1,
)
