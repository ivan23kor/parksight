FROM ultralytics/ultralytics:latest-cpu

WORKDIR /kaggle/working

# Mimic Kaggle paths
RUN mkdir -p /kaggle/input /kaggle/working

# Install jupyter
RUN pip install jupyter nbconvert

COPY parking_sign_training.ipynb /kaggle/working/
